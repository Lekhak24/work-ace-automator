import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Function to extract meeting links from email body
function extractMeetingInfo(subject: string, body: string): { joinUrl: string | null; meetingType: string | null } {
  const meetingPatterns = [
    { regex: /https:\/\/[\w.-]*zoom\.us\/j\/[\w?=&-]+/gi, type: "Zoom" },
    { regex: /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[\w%.-]+/gi, type: "Microsoft Teams" },
    { regex: /https:\/\/meet\.google\.com\/[\w-]+/gi, type: "Google Meet" },
    { regex: /https:\/\/[\w.-]*webex\.com\/[\w/.?=&-]+/gi, type: "Webex" },
  ];

  const content = `${subject} ${body}`;
  
  for (const pattern of meetingPatterns) {
    const match = content.match(pattern.regex);
    if (match) {
      return { joinUrl: match[0], meetingType: pattern.type };
    }
  }
  
  return { joinUrl: null, meetingType: null };
}

// Process email with AI for summary, task detection, and classification
async function processEmailWithAI(supabase: any, email: any, userId: string) {
  const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
  
  const classificationPrompt = `Analyze this email and provide a JSON response:
{
  "requestType": "one of: Leave Request, Access Request, IT Support, HR Query, Meeting Request, Task Assignment, External Communication, Urgent Escalation, Information Request, General",
  "urgencyLevel": "one of: low, medium, high, critical",
  "summary": "2-3 sentence summary of the email",
  "suggestedTeam": "one of: HR, IT, Management, Operations, Finance, General",
  "containsTask": true/false,
  "taskDescription": "if containsTask is true, describe the task briefly",
  "isMeetingInvite": true/false,
  "meetingTitle": "if meeting invite, the meeting title",
  "meetingDateTime": "if meeting invite, ISO datetime string or null"
}

Email:
From: ${email.sender}
Subject: ${email.subject}
Body: ${email.body?.substring(0, 3000) || ""}

Respond ONLY with valid JSON.`;

  let classification = {
    requestType: "General",
    urgencyLevel: "medium",
    summary: `Email from ${email.sender} regarding "${email.subject}"`,
    suggestedTeam: "General",
    containsTask: false,
    taskDescription: "",
    isMeetingInvite: false,
    meetingTitle: "",
    meetingDateTime: null as string | null,
  };

  if (lovableApiKey) {
    try {
      const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "You are an AI email classifier. Always respond with valid JSON only." },
            { role: "user", content: classificationPrompt },
          ],
        }),
      });

      if (aiResponse.ok) {
        const aiData = await aiResponse.json();
        const content = aiData.choices?.[0]?.message?.content || "";
        console.log("AI Response for email:", email.subject);
        
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          classification = { ...classification, ...JSON.parse(jsonMatch[0]) };
        }
      } else {
        console.error("AI API error:", aiResponse.status);
      }
    } catch (aiError) {
      console.error("AI classification error:", aiError);
    }
  }

  // Update email with summary
  await supabase
    .from("emails")
    .update({
      summary: classification.summary,
      is_processed: true,
      has_task: classification.containsTask,
    })
    .eq("id", email.id);

  console.log("Email processed:", email.subject, "Summary:", classification.summary);

  // Create email classification record
  const { data: requestType } = await supabase
    .from("request_types")
    .select("id")
    .eq("name", classification.requestType)
    .maybeSingle();

  await supabase.from("email_classifications").insert({
    email_id: email.id,
    request_type_id: requestType?.id || null,
    urgency_level: classification.urgencyLevel,
    routing_team: classification.suggestedTeam,
    confidence_score: 0.85,
    auto_reply_sent: false,
  });

  // Create task if detected
  if (classification.containsTask && classification.taskDescription) {
    const { error: taskError } = await supabase.from("tasks").insert({
      user_id: userId,
      email_id: email.id,
      title: classification.taskDescription.substring(0, 100),
      description: classification.taskDescription,
      priority: classification.urgencyLevel === "critical" ? "high" : classification.urgencyLevel,
      status: "pending",
    });
    
    if (!taskError) {
      console.log("Task created from email:", classification.taskDescription);
    }
  }

  // Create team assignment
  await supabase.from("team_assignments").insert({
    email_id: email.id,
    team_name: classification.suggestedTeam,
  });

  // Check for meeting links in email
  const { joinUrl, meetingType } = extractMeetingInfo(email.subject, email.body || "");
  
  if (classification.isMeetingInvite || joinUrl) {
    const meetingTitle = classification.meetingTitle || email.subject;
    let startTime = new Date();
    let endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // Default 1 hour

    if (classification.meetingDateTime) {
      try {
        startTime = new Date(classification.meetingDateTime);
        endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
      } catch (e) {
        console.log("Could not parse meeting datetime");
      }
    }

    const { error: meetingError } = await supabase.from("meetings").insert({
      user_id: userId,
      title: meetingTitle,
      meeting_id: email.email_id,
      join_url: joinUrl,
      start_time: startTime.toISOString(),
      end_time: endTime.toISOString(),
      attendees: { source: email.sender, type: meetingType },
    });

    if (!meetingError) {
      console.log("Meeting created:", meetingTitle, "Join URL:", joinUrl);
    } else {
      console.error("Meeting insert error:", meetingError);
    }
  }

  return classification;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    // Get the user from the authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("No authorization header");
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);

    if (userError || !user) {
      console.error("Auth error:", userError);
      throw new Error("Unauthorized");
    }

    console.log("Fetching emails for user:", user.id);

    // Get user's Google tokens
    const { data: settings, error: settingsError } = await supabase
      .from("user_settings")
      .select("google_access_token, google_refresh_token, google_token_expires_at")
      .eq("user_id", user.id)
      .single();

    if (settingsError || !settings?.google_access_token) {
      console.error("Settings error:", settingsError);
      throw new Error("Google not connected. Please connect your Google account first.");
    }

    let accessToken = settings.google_access_token;

    // Check if token is expired and refresh if needed
    if (settings.google_token_expires_at) {
      const expiresAt = new Date(settings.google_token_expires_at);
      if (expiresAt <= new Date() && settings.google_refresh_token) {
        console.log("Token expired, refreshing...");
        
        const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
        const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");

        const refreshResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID!,
            client_secret: GOOGLE_CLIENT_SECRET!,
            refresh_token: settings.google_refresh_token,
            grant_type: "refresh_token",
          }),
        });

        const refreshText = await refreshResponse.text();
        console.log("Refresh response status:", refreshResponse.status, "body:", refreshText);
        
        if (refreshResponse.ok) {
          const refreshData = JSON.parse(refreshText);
          accessToken = refreshData.access_token;
          
          // Update stored token
          await supabase
            .from("user_settings")
            .update({
              google_access_token: accessToken,
              google_token_expires_at: new Date(Date.now() + refreshData.expires_in * 1000).toISOString(),
            })
            .eq("user_id", user.id);
            
          console.log("Token refreshed successfully");
        } else {
          // Clear invalid tokens so user can reconnect
          await supabase
            .from("user_settings")
            .update({
              google_access_token: null,
              google_refresh_token: null,
              google_token_expires_at: null,
            })
            .eq("user_id", user.id);
            
          throw new Error("Google token expired. Please reconnect your Google account in Settings.");
        }
      }
    }

    // Fetch emails from Gmail API
    console.log("Fetching messages from Gmail...");
    const messagesResponse = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&labelIds=INBOX",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    if (!messagesResponse.ok) {
      const errorText = await messagesResponse.text();
      console.error("Gmail API error:", errorText);
      throw new Error("Failed to fetch emails from Gmail");
    }

    const messagesData = await messagesResponse.json();
    const messages = messagesData.messages || [];

    console.log(`Found ${messages.length} messages`);

    const storedEmails = [];
    let tasksCreated = 0;
    let meetingsCreated = 0;

    // Fetch full details for each message
    for (const message of messages) {
      try {
        // Check if email already exists
        const { data: existingEmail } = await supabase
          .from("emails")
          .select("id")
          .eq("email_id", message.id)
          .eq("user_id", user.id)
          .maybeSingle();

        if (existingEmail) {
          console.log("Email already exists:", message.id);
          continue;
        }

        // Fetch full message details
        const detailResponse = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        if (!detailResponse.ok) continue;

        const emailData = await detailResponse.json();
        const headers = emailData.payload?.headers || [];

        const getHeader = (name: string) => 
          headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

        const subject = getHeader("Subject") || "(No Subject)";
        const from = getHeader("From") || "Unknown";
        const dateStr = getHeader("Date");
        const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();

        // Extract body
        let body = "";
        if (emailData.payload?.body?.data) {
          body = atob(emailData.payload.body.data.replace(/-/g, "+").replace(/_/g, "/"));
        } else if (emailData.payload?.parts) {
          const textPart = emailData.payload.parts.find(
            (p: any) => p.mimeType === "text/plain"
          );
          if (textPart?.body?.data) {
            body = atob(textPart.body.data.replace(/-/g, "+").replace(/_/g, "/"));
          }
        }

        // Store email
        const { data: insertedEmail, error: insertError } = await supabase
          .from("emails")
          .insert({
            email_id: message.id,
            user_id: user.id,
            subject,
            sender: from,
            body: body.substring(0, 10000),
            received_at: receivedAt,
          })
          .select()
          .single();

        if (insertError) {
          console.error("Error inserting email:", insertError);
        } else {
          storedEmails.push(insertedEmail);
          console.log("Stored email:", subject);
          
          // Auto-process each email with AI
          try {
            const result = await processEmailWithAI(supabase, insertedEmail, user.id);
            if (result.containsTask) tasksCreated++;
            if (result.isMeetingInvite || extractMeetingInfo(subject, body).joinUrl) meetingsCreated++;
          } catch (processError) {
            console.error("Error auto-processing email:", processError);
          }
        }
      } catch (emailError) {
        console.error("Error processing email:", emailError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        fetched: messages.length,
        stored: storedEmails.length,
        tasksCreated,
        meetingsCreated,
        emails: storedEmails,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Fetch Gmail error:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
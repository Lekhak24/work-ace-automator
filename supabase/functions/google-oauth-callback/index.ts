import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function escapeForScript(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ");
}

function buildHtmlResponse({
  title,
  message,
  messageType,
  status = 200,
}: {
  title: string;
  message: string;
  messageType: "GOOGLE_AUTH_SUCCESS" | "GOOGLE_AUTH_ERROR";
  status?: number;
}) {
  const escapedMessage = escapeForScript(message);
  const payload =
    messageType === "GOOGLE_AUTH_ERROR"
      ? `{ type: '${messageType}', error: '${escapedMessage}' }`
      : `{ type: '${messageType}' }`;

  return new Response(
    `<!DOCTYPE html>
    <html>
      <head><title>${title}</title></head>
      <body>
        <script>
          window.opener?.postMessage(${payload}, '*');
          setTimeout(() => window.close(), 2000);
        </script>
        <p>${message}</p>
      </body>
    </html>`,
    {
      status,
      headers: { "Content-Type": "text/html", ...corsHeaders },
    }
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    console.log("Google OAuth callback received:", { code: !!code, state, error });

    if (error) {
      console.error("Google OAuth error:", error);
      return buildHtmlResponse({
        title: "Authentication Failed",
        message: `Authentication failed: ${error}. This window will close automatically.`,
        messageType: "GOOGLE_AUTH_ERROR",
        status: 400,
      });
    }

    if (!code || !state) {
      console.error("Missing code or state");
      return buildHtmlResponse({
        title: "Authentication Failed",
        message: "Missing authorization code or state. This window will close automatically.",
        messageType: "GOOGLE_AUTH_ERROR",
        status: 400,
      });
    }

    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID");
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error("Missing Google credentials");
      throw new Error("Google credentials not configured");
    }

    const redirectUri = `${SUPABASE_URL}/functions/v1/google-oauth-callback`;

    console.log("Exchanging code for tokens...");
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Token exchange failed:", errorText);
      throw new Error(`Token exchange failed: ${errorText}`);
    }

    const tokenData = await tokenResponse.json();
    console.log("Token exchange successful");

    const { access_token, refresh_token, expires_in } = tokenData;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);

    const { data: existingSettings, error: existingSettingsError } = await supabase
      .from("user_settings")
      .select("id, google_refresh_token")
      .eq("user_id", state)
      .maybeSingle();

    if (existingSettingsError) {
      console.error("Failed to load user settings:", existingSettingsError);
      throw existingSettingsError;
    }

    const gmailProfileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: {
        Authorization: `Bearer ${access_token}`,
      },
    });

    if (!gmailProfileResponse.ok) {
      const gmailErrorText = await gmailProfileResponse.text();
      console.error("Gmail scope validation failed:", gmailErrorText);

      await supabase
        .from("user_settings")
        .update({
          google_access_token: null,
          google_refresh_token: null,
          google_token_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", state);

      throw new Error(
        gmailErrorText.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || gmailErrorText.includes("insufficientPermissions")
          ? "Gmail permission is missing. Please enable the Gmail API, add the Gmail readonly scope in your Google OAuth app, and reconnect."
          : "Google connected, but Gmail access could not be verified. Please reconnect and try again."
      );
    }

    const nextRefreshToken = refresh_token || existingSettings?.google_refresh_token || null;

    if (existingSettings) {
      const { error: updateError } = await supabase
        .from("user_settings")
        .update({
          google_access_token: access_token,
          google_refresh_token: nextRefreshToken,
          google_token_expires_at: expiresAt,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", state);

      if (updateError) {
        console.error("Failed to update user settings:", updateError);
        throw updateError;
      }
    } else {
      const { error: insertError } = await supabase
        .from("user_settings")
        .insert({
          user_id: state,
          google_access_token: access_token,
          google_refresh_token: nextRefreshToken,
          google_token_expires_at: expiresAt,
        });

      if (insertError) {
        console.error("Failed to insert user settings:", insertError);
        throw insertError;
      }
    }

    console.log("Tokens stored successfully for user:", state);

    return buildHtmlResponse({
      title: "Authentication Successful",
      message: "Authentication successful! This window will close automatically.",
      messageType: "GOOGLE_AUTH_SUCCESS",
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Google OAuth callback error:", error);
    return buildHtmlResponse({
      title: "Authentication Failed",
      message: `Authentication failed: ${errorMessage}. This window will close automatically.`,
      messageType: "GOOGLE_AUTH_ERROR",
      status: 400,
    });
  }
});

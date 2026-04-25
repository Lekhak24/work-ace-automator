import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mail, Loader2, Check, RefreshCw, Copy, ExternalLink } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface GoogleConnectProps {
  userId: string;
  userEmail?: string;
}

const GoogleConnect = ({ userId, userEmail }: GoogleConnectProps) => {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [showManualFlow, setShowManualFlow] = useState(false);
  const [authCode, setAuthCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  const clientId = "207591132098-ikj5llsls140c9tlkter4l6urdnm3jd9.apps.googleusercontent.com";
  const redirectUri = "https://jjsdaubedeyuuywilvjt.supabase.co/functions/v1/google-oauth-callback";
  const scope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

  const authUrl = useMemo(() =>
    `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${clientId}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(scope)}` +
      `&state=${userId}` +
      `&access_type=offline` +
      `&prompt=consent`,
    [clientId, redirectUri, scope, userId]
  );

  useEffect(() => {
    void checkConnectionStatus();
    
    // Listen for OAuth callback messages
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'GOOGLE_AUTH_SUCCESS') {
        setIsConnected(true);
        setIsConnecting(false);
        setShowManualFlow(false);
        void checkConnectionStatus();
        toast({
          title: "Connected!",
          description: "Your Google account is now connected.",
        });
      } else if (event.data?.type === 'GOOGLE_AUTH_ERROR') {
        setIsConnected(false);
        setIsConnecting(false);
        toast({
          title: "Connection failed",
          description: event.data.error || "Failed to connect Google account",
          variant: "destructive",
        });
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const checkConnectionStatus = async () => {
    const { data } = await supabase
      .from("user_settings")
      .select("google_access_token, email_sync_enabled")
      .eq("user_id", userId)
      .maybeSingle();

    const settings = data as { google_access_token?: string | null; email_sync_enabled?: boolean | null } | null;
    setIsConnected(Boolean(settings?.google_access_token && settings?.email_sync_enabled !== false));
  };

  const handleConnect = () => {
    setIsConnecting(true);
    
    // Open OAuth popup
    const popup = window.open(authUrl, 'Google OAuth', 'width=600,height=700');
    
    // Check if popup was blocked
    if (!popup) {
      toast({
        title: "Popup blocked",
        description: "Please use the manual connection method below",
        variant: "destructive",
      });
      setIsConnecting(false);
      setShowManualFlow(true);
      return;
    }

    // Monitor popup close
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkClosed);
        setIsConnecting(false);
        void checkConnectionStatus();
      }
    }, 500);
  };

  const copyAuthUrl = () => {
    navigator.clipboard.writeText(authUrl);
    toast({
      title: "URL Copied!",
      description: "Open this URL in a browser where Google is not blocked",
    });
  };

  const handleManualSubmit = async () => {
    if (!authCode.trim()) {
      toast({
        title: "Missing code",
        description: "Please paste the authorization code",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      // Call the OAuth callback with the code
      const response = await fetch(
        `https://jjsdaubedeyuuywilvjt.supabase.co/functions/v1/google-oauth-callback?code=${encodeURIComponent(authCode.trim())}&state=${userId}`,
        { method: "GET" }
      );

      const html = await response.text();

      if (!response.ok) {
        const errorMatch = html.match(/Authentication failed:([^<]+)/i);
        throw new Error(errorMatch?.[1]?.trim() || "Failed to exchange authorization code");
      }

      const success = html.includes("GOOGLE_AUTH_SUCCESS") || html.includes("Authentication successful");
      if (!success) {
        throw new Error("Google connection could not be verified");
      }

      setIsConnected(true);
      setShowManualFlow(false);
      setAuthCode("");
      await checkConnectionStatus();
      toast({
        title: "Connected!",
        description: "Your Google account is now connected.",
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast({
        title: "Connection failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFetchEmails = async () => {
    setIsFetching(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      const response = await fetch(
        `https://jjsdaubedeyuuywilvjt.supabase.co/functions/v1/fetch-gmail`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
        }
      );

      const result = await response.json();

      if (!response.ok) {
        const message = result.error || "Failed to fetch emails";
        if (message.toLowerCase().includes("reconnect") || message.toLowerCase().includes("permission")) {
          setIsConnected(false);
        }
        throw new Error(message);
      }

      const messages = [];
      if (result.stored > 0) messages.push(`${result.stored} new emails processed`);
      if (result.tasksCreated > 0) messages.push(`${result.tasksCreated} tasks created`);
      if (result.meetingsCreated > 0) messages.push(`${result.meetingsCreated} meetings detected`);
      
      toast({
        title: "Emails synced successfully!",
        description: messages.length > 0 ? messages.join(", ") : `Checked ${result.fetched} emails, no new ones found.`,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toast({
        title: "Sync failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsFetching(false);
    }
  };

  return (
    <Card className="border-2 border-primary/20 overflow-hidden">
      <CardHeader className="bg-gradient-to-r from-primary/10 to-primary/5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
            <Mail className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <CardTitle className="text-lg">Google Gmail</CardTitle>
            <CardDescription>
              {isConnected ? "Connected - sync your emails" : "Connect to fetch emails automatically"}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="space-y-4">
          {isConnected ? (
            <>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                <Check className="w-5 h-5 text-green-600" />
                <span className="text-sm font-medium text-green-700">Google account connected</span>
              </div>
              <Button 
                onClick={handleFetchEmails} 
                disabled={isFetching}
                className="w-full"
              >
                {isFetching ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Syncing emails...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Sync Emails Now
                  </>
                )}
              </Button>
            </>
          ) : showManualFlow ? (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-sm font-medium text-amber-700 mb-2">Manual Connection Steps:</p>
                <ol className="text-xs text-amber-600 space-y-1 list-decimal list-inside">
                  <li>Copy the auth URL below</li>
                  <li>Open it in a browser where Google is NOT blocked (home/mobile)</li>
                  <li>Sign in with your Google account</li>
                  <li>After redirect, copy the "code" from the URL bar</li>
                  <li>Paste it below and click Submit</li>
                </ol>
              </div>
              
              <div className="flex gap-2">
                <Button onClick={copyAuthUrl} variant="outline" className="flex-1">
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Auth URL
                </Button>
                <Button onClick={() => window.open(authUrl, '_blank')} variant="outline">
                  <ExternalLink className="w-4 h-4" />
                </Button>
              </div>

              <div className="space-y-2">
                <Input
                  placeholder="Paste authorization code here..."
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                />
                <Button 
                  onClick={handleManualSubmit} 
                  disabled={isSubmitting}
                  className="w-full"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    "Submit Code"
                  )}
                </Button>
              </div>

              <Button 
                variant="ghost" 
                onClick={() => setShowManualFlow(false)}
                className="w-full text-muted-foreground"
              >
                Back to automatic connection
              </Button>
            </div>
          ) : (
            <>
              <Button 
                onClick={handleConnect} 
                disabled={isConnecting}
                className="w-full"
                size="lg"
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 mr-2" />
                    Connect Google Account
                  </>
                )}
              </Button>
              <Button 
                variant="outline" 
                onClick={() => setShowManualFlow(true)}
                className="w-full"
              >
                Network blocked? Use manual connection
              </Button>
              <p className="text-xs text-muted-foreground text-center">
                If Google is blocked on your network, use manual connection
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default GoogleConnect;

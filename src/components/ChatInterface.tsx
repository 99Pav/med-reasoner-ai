import { useState, useRef, useEffect, useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import { UserContextForm } from "./UserContextForm";
import { MessageBubble } from "./MessageBubble";
import { QueryInput } from "./QueryInput";
import { streamResearchChat } from "@/lib/streamChat";
import { getSessionId } from "@/lib/sessionId";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Microscope, History, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatMessage, UserProfile } from "@/types/research";

export function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserProfile>({
    name: "",
    diseaseOfInterest: "",
    location: "",
  });
  const [conversations, setConversations] = useState<{ id: string; disease_context: string | null; created_at: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const sessionId = getSessionId();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Load conversations list
  useEffect(() => {
    supabase
      .from("conversations")
      .select("id, disease_context, created_at")
      .eq("user_session_id", sessionId)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        if (data) setConversations(data);
      });
  }, [sessionId, conversationId]);

  // Load profile
  useEffect(() => {
    supabase
      .from("user_profiles")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setProfile({
            name: data.name || "",
            diseaseOfInterest: data.disease_of_interest || "",
            location: data.location || "",
          });
        }
      });
  }, [sessionId]);

  const handleProfileUpdate = async (newProfile: UserProfile) => {
    setProfile(newProfile);
    await supabase.from("user_profiles").upsert(
      {
        session_id: sessionId,
        name: newProfile.name,
        disease_of_interest: newProfile.diseaseOfInterest,
        location: newProfile.location,
      },
      { onConflict: "session_id" }
    );

    // Update disease context on current conversation
    if (conversationId && newProfile.diseaseOfInterest) {
      await supabase
        .from("conversations")
        .update({ disease_context: newProfile.diseaseOfInterest })
        .eq("id", conversationId);
    }

    toast({ title: "Context updated", description: "Your profile has been saved." });
  };

  const startNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setShowHistory(false);
  };

  const loadConversation = async (convId: string) => {
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    if (data) {
      setMessages(
        data.map((m) => ({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : (m.content as any)?.text || JSON.stringify(m.content),
          timestamp: new Date(m.created_at),
        }))
      );
      setConversationId(convId);
    }
    setShowHistory(false);
  };

  const handleSend = useCallback(
    async (message: string) => {
      setIsLoading(true);
      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: "user",
        content: message,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Create or reuse conversation
      let convId = conversationId;
      if (!convId) {
        const { data } = await supabase
          .from("conversations")
          .insert({
            user_session_id: sessionId,
            disease_context: profile.diseaseOfInterest || null,
          })
          .select("id")
          .single();
        if (data) {
          convId = data.id;
          setConversationId(convId);
        }
      }

      // Save user message
      if (convId) {
        await supabase.from("messages").insert({
          conversation_id: convId,
          role: "user",
          content: JSON.stringify(message),
        });
      }

      const conversationHistory = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      let assistantContent = "";
      const assistantId = uuidv4();

      try {
        await streamResearchChat({
          message,
          diseaseContext: profile.diseaseOfInterest || null,
          conversationHistory: [...conversationHistory, { role: "user", content: message }],
          userProfile: { name: profile.name, location: profile.location },
          onDelta: (chunk) => {
            assistantContent += chunk;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.id === assistantId) {
                return prev.map((m, i) =>
                  i === prev.length - 1 ? { ...m, content: assistantContent } : m
                );
              }
              return [
                ...prev,
                { id: assistantId, role: "assistant", content: assistantContent, timestamp: new Date() },
              ];
            });
          },
          onDone: async () => {
            setIsLoading(false);
            // Save assistant message
            if (convId && assistantContent) {
              await supabase.from("messages").insert({
                conversation_id: convId,
                role: "assistant",
                content: JSON.stringify(assistantContent),
              });
            }
          },
          onError: (error) => {
            setIsLoading(false);
            toast({ title: "Error", description: error, variant: "destructive" });
          },
        });
      } catch (e) {
        setIsLoading(false);
        toast({ title: "Error", description: "Failed to get response", variant: "destructive" });
      }
    },
    [conversationId, messages, profile, sessionId, toast]
  );

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <div className="w-72 border-r border-border flex flex-col bg-muted/30">
        <div className="p-4 border-b border-border">
          <div className="flex items-center gap-2 mb-4">
            <Microscope className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">MedResearch AI</h1>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="flex-1" onClick={startNewConversation}>
              <Plus className="h-3 w-3 mr-1" /> New Chat
            </Button>
            <Button
              size="sm"
              variant={showHistory ? "default" : "outline"}
              onClick={() => setShowHistory(!showHistory)}
            >
              <History className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {showHistory ? (
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            <p className="text-xs text-muted-foreground px-2 py-1">Past conversations</p>
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => loadConversation(conv.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors ${
                  conv.id === conversationId ? "bg-accent" : ""
                }`}
              >
                <p className="font-medium truncate">{conv.disease_context || "General query"}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(conv.created_at).toLocaleDateString()}
                </p>
              </button>
            ))}
            {conversations.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">No conversations yet</p>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-3">
            <UserContextForm profile={profile} onUpdate={handleProfileUpdate} />
          </div>
        )}
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Microscope className="h-16 w-16 text-muted-foreground/30 mb-4" />
              <h2 className="text-xl font-semibold text-foreground mb-2">
                Medical Research Assistant
              </h2>
              <p className="text-muted-foreground max-w-md text-sm">
                Ask about treatments, clinical trials, or research publications.
                Set your patient context in the sidebar for personalized results.
              </p>
              <div className="flex flex-wrap gap-2 mt-6 max-w-lg justify-center">
                {[
                  "Latest treatment for lung cancer",
                  "Clinical trials for diabetes",
                  "Recent studies on heart disease",
                  "Top researchers in Alzheimer's",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSend(q)}
                    className="text-xs px-3 py-1.5 rounded-full border border-border hover:bg-accent transition-colors text-muted-foreground"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {isLoading && messages[messages.length - 1]?.role === "user" && (
            <div className="flex gap-3">
              <div className="flex-shrink-0 h-8 w-8 rounded-full bg-primary flex items-center justify-center">
                <Microscope className="h-4 w-4 text-primary-foreground animate-pulse" />
              </div>
              <div className="space-y-2 flex-1 max-w-[80%]">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <p className="text-xs text-muted-foreground">
                  Searching PubMed, OpenAlex & ClinicalTrials.gov...
                </p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-border p-4">
          <QueryInput onSend={handleSend} isLoading={isLoading} />
        </div>
      </div>
    </div>
  );
}

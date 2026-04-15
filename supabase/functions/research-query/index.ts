import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface Publication {
  title: string;
  abstract: string;
  authors: string[];
  year: number;
  source: "PubMed" | "OpenAlex";
  url: string;
}

interface ClinicalTrial {
  title: string;
  status: string;
  eligibility: string;
  location: string;
  contact: string;
  url: string;
}

// ── Step A: Query Expansion ──
async function expandQuery(
  userMessage: string,
  diseaseContext: string | null,
  conversationHistory: { role: string; content: string }[],
  apiKey: string
): Promise<{ expandedQuery: string; diseaseKeyword: string }> {
  const systemPrompt = `You are a medical research query expansion engine. Given a user question, disease context, and conversation history, produce an expanded search query optimized for PubMed, OpenAlex, and ClinicalTrials.gov.

Rules:
- Combine the user's question with the disease context intelligently.
- Add relevant medical synonyms or MeSH-style terms.
- If the user asks a follow-up, use conversation history to infer the disease/topic.
- Return ONLY a JSON object: {"expandedQuery": "...", "diseaseKeyword": "..."}
- diseaseKeyword should be the primary disease/condition being discussed.
- Do NOT include any other text.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-6).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    {
      role: "user",
      content: `Disease context: ${diseaseContext || "Not specified"}\nUser question: ${userMessage}`,
    },
  ];

  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages,
    }),
  });

  if (!resp.ok) {
    console.error("Query expansion failed:", resp.status, await resp.text());
    return { expandedQuery: userMessage, diseaseKeyword: diseaseContext || userMessage };
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {
    // fallback
  }
  return { expandedQuery: userMessage, diseaseKeyword: diseaseContext || userMessage };
}

// ── Step B1: PubMed ──
async function fetchPubMed(query: string, retmax = 100): Promise<Publication[]> {
  try {
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=pub+date&retmode=json`;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    const ids: string[] = searchData?.esearchresult?.idlist || [];

    if (ids.length === 0) return [];

    const fetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(",")}&retmode=xml`;
    const fetchResp = await fetch(fetchUrl);
    const xml = await fetchResp.text();

    const publications: Publication[] = [];
    const articles = xml.split("<PubmedArticle>");

    for (let i = 1; i < articles.length; i++) {
      const article = articles[i];
      const titleMatch = article.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
      const abstractMatch = article.match(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/);
      const yearMatch = article.match(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/);
      const pmidMatch = article.match(/<PMID[^>]*>(\d+)<\/PMID>/);

      const authorMatches = [...article.matchAll(/<LastName>(.*?)<\/LastName>[\s\S]*?<ForeName>(.*?)<\/ForeName>/g)];
      const authors = authorMatches.slice(0, 5).map((m) => `${m[2]} ${m[1]}`);

      if (titleMatch) {
        publications.push({
          title: titleMatch[1].replace(/<[^>]*>/g, ""),
          abstract: abstractMatch ? abstractMatch[1].replace(/<[^>]*>/g, "").slice(0, 500) : "",
          authors,
          year: yearMatch ? parseInt(yearMatch[1]) : 0,
          source: "PubMed",
          url: pmidMatch ? `https://pubmed.ncbi.nlm.nih.gov/${pmidMatch[1]}/` : "",
        });
      }
    }
    return publications;
  } catch (e) {
    console.error("PubMed fetch error:", e);
    return [];
  }
}

// ── Step B2: OpenAlex ──
async function fetchOpenAlex(query: string, perPage = 100): Promise<Publication[]> {
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${perPage}&page=1&sort=relevance_score:desc&filter=from_publication_date:2019-01-01`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "MedResearchAssistant/1.0 (mailto:research@example.com)" },
    });
    const data = await resp.json();

    return (data.results || []).map((work: any) => ({
      title: work.title || "Untitled",
      abstract: work.abstract_inverted_index
        ? reconstructAbstract(work.abstract_inverted_index).slice(0, 500)
        : "",
      authors: (work.authorships || []).slice(0, 5).map((a: any) => a.author?.display_name || "Unknown"),
      year: work.publication_year || 0,
      source: "OpenAlex" as const,
      url: work.doi ? `https://doi.org/${work.doi.replace("https://doi.org/", "")}` : work.id || "",
    }));
  } catch (e) {
    console.error("OpenAlex fetch error:", e);
    return [];
  }
}

function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, w]) => w).join(" ");
}

// ── Step B3: ClinicalTrials.gov ──
async function fetchClinicalTrials(
  disease: string,
  query: string,
  location: string | null,
  pageSize = 50
): Promise<ClinicalTrial[]> {
  try {
    let url = `https://clinicaltrials.gov/api/v2/studies?query.cond=${encodeURIComponent(disease)}&query.term=${encodeURIComponent(query)}&filter.overallStatus=RECRUITING,ACTIVE_NOT_RECRUITING,ENROLLING_BY_INVITATION&pageSize=${pageSize}&format=json`;

    const resp = await fetch(url);
    const data = await resp.json();

    return (data.studies || []).map((study: any) => {
      const proto = study.protocolSection || {};
      const id = proto.identificationModule || {};
      const status = proto.statusModule || {};
      const eligibility = proto.eligibilityModule || {};
      const contacts = proto.contactsLocationsModule || {};
      const locations = contacts.locations || [];

      let locationStr = "Not specified";
      if (locations.length > 0) {
        const loc = locations[0];
        locationStr = [loc.facility, loc.city, loc.state, loc.country].filter(Boolean).join(", ");
      }

      let contactStr = "Not specified";
      const centralContacts = contacts.centralContacts || [];
      if (centralContacts.length > 0) {
        const c = centralContacts[0];
        contactStr = [c.name, c.email, c.phone].filter(Boolean).join(" | ");
      }

      return {
        title: id.officialTitle || id.briefTitle || "Untitled",
        status: status.overallStatus || "Unknown",
        eligibility: eligibility.eligibilityCriteria
          ? eligibility.eligibilityCriteria.slice(0, 300)
          : "Not specified",
        location: locationStr,
        contact: contactStr,
        url: `https://clinicaltrials.gov/study/${id.nctId || ""}`,
      };
    });
  } catch (e) {
    console.error("ClinicalTrials fetch error:", e);
    return [];
  }
}

// ── Step C: LLM Ranking & Response Generation ──
async function generateResponse(
  userMessage: string,
  publications: Publication[],
  trials: ClinicalTrial[],
  diseaseContext: string | null,
  conversationHistory: { role: string; content: string }[],
  userProfile: { name?: string; location?: string } | null,
  apiKey: string
): Promise<string> {
  const systemPrompt = `You are a Medical Research Assistant that provides structured, research-backed answers.

You have been given research publications and clinical trials retrieved from PubMed, OpenAlex, and ClinicalTrials.gov.

RULES:
1. ONLY reference sources provided below. Never hallucinate or invent sources.
2. Personalize responses using the user's disease context and profile.
3. Structure your response with these sections using markdown:
   ## Condition Overview
   A brief, clear overview of the condition/topic.
   
   ## Research Insights
   Summarize the top 6-8 most relevant publications. For each, include:
   - Title, authors, year
   - Key finding or relevance
   - Source (PubMed/OpenAlex)
   
   ## Clinical Trials
   Summarize top 3-5 relevant clinical trials. For each, include:
   - Title, status, location
   - Brief eligibility criteria
   - Contact info if available
   
   ## Summary
   A personalized summary tying together the research and trials.

4. Rank publications by: relevance to query > recency > source credibility.
5. Instead of generic statements, be specific: e.g., "Based on studies in lung cancer patients..." not "Vitamin D is good."
6. If the user asks about a specific treatment, focus on that treatment in the context of their disease.`;

  const pubsSummary = publications.slice(0, 30).map((p, i) => 
    `[${i + 1}] "${p.title}" by ${p.authors.join(", ")} (${p.year}, ${p.source}) - ${p.url}\nAbstract: ${p.abstract}`
  ).join("\n\n");

  const trialsSummary = trials.slice(0, 15).map((t, i) =>
    `[T${i + 1}] "${t.title}"\nStatus: ${t.status} | Location: ${t.location} | Contact: ${t.contact}\nEligibility: ${t.eligibility}\nURL: ${t.url}`
  ).join("\n\n");

  const userContext = userProfile
    ? `User: ${userProfile.name || "Anonymous"}, Location: ${userProfile.location || "Not specified"}`
    : "User context not provided";

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-10).map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    })),
    {
      role: "user",
      content: `${userContext}
Disease context: ${diseaseContext || "Not specified"}

Question: ${userMessage}

=== RETRIEVED PUBLICATIONS (${publications.length} total, showing top 30) ===
${pubsSummary}

=== RETRIEVED CLINICAL TRIALS (${trials.length} total, showing top 15) ===
${trialsSummary}

Please provide a structured, personalized, research-backed response. Only reference the sources provided above.`,
    },
  ];

  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages,
      stream: true,
    }),
  });

  if (!resp.ok) {
    const status = resp.status;
    const text = await resp.text();
    console.error("LLM response generation failed:", status, text);
    if (status === 429) throw new Error("RATE_LIMITED");
    if (status === 402) throw new Error("PAYMENT_REQUIRED");
    throw new Error(`LLM error: ${status}`);
  }

  return "STREAM:" + resp.body;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { message, diseaseContext, conversationHistory, userProfile } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    // Step A: Query expansion
    const { expandedQuery, diseaseKeyword } = await expandQuery(
      message,
      diseaseContext,
      conversationHistory || [],
      LOVABLE_API_KEY
    );

    console.log("Expanded query:", expandedQuery, "Disease:", diseaseKeyword);

    // Step B: Parallel retrieval
    const [pubmedResults, openAlexResults, clinicalTrials] = await Promise.all([
      fetchPubMed(expandedQuery, 100),
      fetchOpenAlex(expandedQuery, 100),
      fetchClinicalTrials(diseaseKeyword, expandedQuery, userProfile?.location || null, 50),
    ]);

    console.log(
      `Retrieved: PubMed=${pubmedResults.length}, OpenAlex=${openAlexResults.length}, Trials=${clinicalTrials.length}`
    );

    const allPublications = [...pubmedResults, ...openAlexResults];

    // Step C: LLM streaming response
    const systemPrompt = `You are a Medical Research Assistant that provides structured, research-backed answers.

You have been given research publications and clinical trials retrieved from PubMed, OpenAlex, and ClinicalTrials.gov.

RULES:
1. ONLY reference sources provided below. Never hallucinate or invent sources.
2. Personalize responses using the user's disease context and profile.
3. Structure your response with these sections using markdown:
   ## Condition Overview
   A brief, clear overview of the condition/topic.
   
   ## Research Insights
   Summarize the top 6-8 most relevant publications. For each, include:
   - Title, authors, year
   - Key finding or relevance
   - Source (PubMed/OpenAlex)
   
   ## Clinical Trials
   Summarize top 3-5 relevant clinical trials. For each, include:
   - Title, status, location
   - Brief eligibility criteria
   - Contact info if available
   
   ## Summary
   A personalized summary tying together the research and trials.

4. Rank by: relevance to query > recency > credibility.
5. Be specific and personalized, not generic.
6. If the user asks about a specific treatment, focus on that in the disease context.`;

    const pubsSummary = allPublications.slice(0, 30).map((p, i) =>
      `[${i + 1}] "${p.title}" by ${p.authors.join(", ")} (${p.year}, ${p.source}) - ${p.url}\nAbstract: ${p.abstract}`
    ).join("\n\n");

    const trialsSummary = clinicalTrials.slice(0, 15).map((t, i) =>
      `[T${i + 1}] "${t.title}"\nStatus: ${t.status} | Location: ${t.location} | Contact: ${t.contact}\nEligibility: ${t.eligibility}\nURL: ${t.url}`
    ).join("\n\n");

    const userContext = userProfile
      ? `User: ${userProfile.name || "Anonymous"}, Location: ${userProfile.location || "Not specified"}`
      : "User context not provided";

    const history = (conversationHistory || []).slice(-10).map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

    const llmMessages = [
      { role: "system", content: systemPrompt },
      ...history,
      {
        role: "user",
        content: `${userContext}
Disease context: ${diseaseContext || "Not specified"}

Question: ${message}

=== RETRIEVED PUBLICATIONS (${allPublications.length} total, showing top 30) ===
${pubsSummary}

=== RETRIEVED CLINICAL TRIALS (${clinicalTrials.length} total, showing top 15) ===
${trialsSummary}

Please provide a structured, personalized, research-backed response. Only reference the sources provided above.`,
      },
    ];

    const llmResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: llmMessages,
        stream: true,
      }),
    });

    if (!llmResp.ok) {
      const status = llmResp.status;
      if (status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited. Please try again shortly." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (status === 402) {
        return new Response(JSON.stringify({ error: "Credits exhausted. Please add funds." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await llmResp.text();
      console.error("LLM error:", status, errText);
      return new Response(JSON.stringify({ error: "AI processing failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Stream the response back
    return new Response(llmResp.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    console.error("research-query error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

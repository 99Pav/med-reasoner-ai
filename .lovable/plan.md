

# Medical Research Assistant — Implementation Plan

## Overview
An AI-powered medical research companion built with React + Supabase (Lovable Cloud). Users provide medical context, and the system fetches research from 3 APIs, uses Lovable AI (Gemini) to rank/reason over results, and delivers structured, source-backed answers in a chat interface with multi-turn context.

## Architecture
- **Frontend**: React chat interface with structured input + natural language support
- **Backend**: Supabase Edge Functions for API orchestration + LLM reasoning
- **Database**: Supabase/PostgreSQL for conversations, messages, and user profiles
- **AI**: Lovable AI Gateway (Gemini) for query expansion, ranking, and response generation

---

## 1. Database Schema
- **conversations** table: id, user_session_id, disease_context, created_at
- **messages** table: id, conversation_id, role (user/assistant), content (JSON for structured responses), created_at
- **user_profiles** table: id, session_id, name, disease_of_interest, location, created_at

## 2. Chat Interface (Index Page)
- **Left panel**: User context form (name, disease, location — optional, collapsible)
- **Main area**: Chat messages with markdown rendering
- **Input bar**: Natural language query input
- Structured assistant responses rendered as:
  - Condition Overview section
  - Research Insights cards (title, authors, year, source, URL, snippet)
  - Clinical Trials cards (title, status, eligibility, location, contact)
  - Source attribution footer
- Loading states with skeleton cards during retrieval

## 3. Edge Function: `research-query`
Orchestrates the full pipeline per user message:

**Step A — Query Expansion (LLM call)**
- Takes user message + conversation history + disease context
- LLM expands query intelligently (e.g., "deep brain stimulation" → "deep brain stimulation + Parkinson's disease")
- Returns expanded search terms

**Step B — Parallel Data Retrieval**
- **PubMed**: esearch (retmax=100) → efetch for top IDs → extract title, abstract, authors, year, URL
- **OpenAlex**: search with expanded query (per-page=100, sorted by relevance) → extract title, abstract, authors, year, URL
- **ClinicalTrials.gov**: query.cond + query.term, pageSize=50 → extract title, status, eligibility, location, contact

**Step C — LLM Ranking & Response Generation**
- Send all fetched results (publications + trials) + user context + conversation history to LLM
- Prompt instructs the model to:
  - Rank by relevance, recency, and credibility
  - Select top 6-8 publications and top 3-5 clinical trials
  - Generate structured response with: Condition Overview, Research Insights, Clinical Trials, Source Attribution
  - Personalize based on disease context (e.g., "Based on studies in lung cancer patients…")
  - Never hallucinate — only reference provided sources

**Step D — Return structured JSON response**

## 4. Conversation Context Management
- Store all messages in the `messages` table
- On each new message, send last 10 messages as context to the LLM
- Follow-up questions automatically inherit disease context from conversation
- Disease context can be updated mid-conversation via the context panel

## 5. Frontend Components
- `ChatInterface` — main layout with context panel + message area
- `UserContextForm` — structured input (name, disease, location)
- `MessageBubble` — renders user/assistant messages
- `ResearchCard` — publication display (title, authors, year, source badge, URL link, abstract snippet)
- `ClinicalTrialCard` — trial display (title, status badge, eligibility, location, contact)
- `SourceAttribution` — collapsible source list with links
- `QueryInput` — message input with send button

## 6. UX Details
- First visit: prompt user to optionally fill in context (disease, name, location)
- Typing indicator while LLM processes
- Expandable/collapsible sections in responses (overview, publications, trials)
- Source URLs open in new tabs
- Mobile-responsive layout


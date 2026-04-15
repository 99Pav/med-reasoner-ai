export interface UserProfile {
  name: string;
  diseaseOfInterest: string;
  location: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface Publication {
  title: string;
  abstract: string;
  authors: string[];
  year: number;
  source: "PubMed" | "OpenAlex";
  url: string;
}

export interface ClinicalTrial {
  title: string;
  status: string;
  eligibility: string;
  location: string;
  contact: string;
  url: string;
}

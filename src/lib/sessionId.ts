import { v4 as uuidv4 } from "uuid";

const SESSION_KEY = "medical-research-session-id";

export function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = uuidv4();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

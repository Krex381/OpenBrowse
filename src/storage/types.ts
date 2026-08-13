export type SqlRow = Record<string, unknown>;

export interface Artifact {
  id: string;
  ownerKeyHash: string;
  path: string;
  contentType: string;
  bytes: number;
  createdAt: number;
  expiresAt: number;
}
export interface StoredSession {
  id: string;
  ownerKeyHash?: string;
  persistent: boolean;
  createdAt: number;
  expiresAt: number;
  viewport: { width: number; height: number };
  proxyId?: string;
  storageState?: string;
  liveViewer?: boolean;
}
export interface StoredProxy {
  id: string;
  ownerKeyHash: string;
  name: string;
  url: string;
  allowedDomains: string[];
}
export interface StoredBrowserProfile {
  id: string;
  ownerKeyHash: string;
  name: string;
  storageState: string;
  createdAt: number;
  updatedAt: number;
}
export interface StoredJob {
  id: string;
  ownerKeyHash: string;
  operation: string;
  request: string;
  status: "queued" | "running" | "complete" | "failed";
  artifactId?: string;
  result?: string;
  error?: string;
  expiresAt: number;
}
export interface StoredReplay {
  id: string;
  ownerKeyHash: string;
  sessionId: string;
  artifactId: string;
  createdAt: number;
  expiresAt: number;
}
export interface StoredWebhook {
  id: string;
  ownerKeyHash: string;
  url: string;
  events: string[];
  secret: string;
}
export interface UsageSummary {
  day: string;
  requests: number;
  successful: number;
  failed: number;
}

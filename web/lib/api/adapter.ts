import { demoLeads, demoLeadToStoredPost } from '../demo-data';
import { toLeadRecord, type LeadRecord, type StoredFacebookPost } from '../../../src/lead-data';

export type ConnectionStatus = { muse: boolean | null; facebook: boolean | null; lastScanAt: string | null };

export interface LeadAdapter {
  listLeads(): Promise<LeadRecord[]>;
  getConnectionStatus(): Promise<ConnectionStatus>;
}

/** Demo adapter. Never put Muse agent credentials in browser code. */
export const demoLeadAdapter: LeadAdapter = {
  async listLeads() {
    const now = Date.now();
    return demoLeads.map(lead => toLeadRecord(demoLeadToStoredPost(lead, now)));
  },
  async getConnectionStatus() { return { muse: null, facebook: null, lastScanAt: null }; },
};

/**
 * Implement against end-user authenticated routes once they exist. The current Fastify API only exposes
 * agent-token routes (`/api/agent/*`); see the backend requests in web/README.md for the expected contract.
 */
export class HttpLeadAdapter implements LeadAdapter {
  constructor(private baseUrl: string, private getSessionToken: () => Promise<string | null>) {}
  private async request<T>(path: string): Promise<T> {
    const token = await this.getSessionToken();
    const response = await fetch(`${this.baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
    if (!response.ok) throw new Error('Không tải được dữ liệu. Bạn thử lại nhé.');
    return response.json() as Promise<T>;
  }
  async listLeads() { return (await this.request<StoredFacebookPost[]>('/api/leads')).map(toLeadRecord); }
  getConnectionStatus() { return this.request<ConnectionStatus>('/api/connections'); }
}

import { notFound } from 'next/navigation';
import { LeadDetailPage } from '@/components/lead-results';
import { requireSession } from '@/lib/server/session';
import { getLeadForUser } from '@/lib/server/leads';
import { getWorkflowForUser } from '@/lib/server/workflow';

/** 404 for unknown ids and for posts owned by another user alike. */
export default async function PostDetail({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const lead = await getLeadForUser(session.userId, decodeURIComponent(id));
  if (!lead) notFound();
  return <LeadDetailPage lead={lead} workflow={await getWorkflowForUser(session.userId, [lead.id])}/>;
}

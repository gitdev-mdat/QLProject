import { permanentRedirect } from 'next/navigation';

/** The old customer "Kết nối" page showed internal infrastructure; its place in the app is now group suggestions. */
export default function LegacyConnectionsPage() { permanentRedirect('/app/de-xuat-nhom'); }

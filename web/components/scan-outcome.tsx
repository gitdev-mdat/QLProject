import Link from 'next/link';
import type { ScanRun } from '@/lib/server/leads';
import { scanOutcome, scanTime, sourceNames } from '@/lib/scan-history';

/**
 * One scan in the customer's history, result first: "Tìm thấy 8 lead mới", "Đã tìm xong · Chưa có lead mới" or a
 * failure. The search name is a second line, shown only when the customer has more than one search.
 */
export function ScanRow({ scan, when, showSource, linkSource = false }: { scan: ScanRun; when: string; showSource: boolean; linkSource?: boolean }) {
  const outcome = scanOutcome(scan);
  return <li className={`scan-row is-${outcome.tone}`}>
    <time dateTime={scan.scannedAt} title={scanTime(scan.scannedAt)}>{when}</time>
    <div className="scan-row-main">
      <p className="scan-row-result">
        {outcome.tag && <span className={`scan-tag is-${outcome.tone}`}>{outcome.tag}</span>}
        {outcome.count ? <>Tìm thấy <b className="scan-lead-count">{outcome.count}</b> lead mới</> : outcome.text}
      </p>
      {showSource && <ScanSource scan={scan} link={linkSource}/>}
    </div>
  </li>;
}

function ScanSource({ scan, link }: { scan: ScanRun; link: boolean }) {
  if (!scan.profile) return <span className="scan-row-source is-legacy">Lượt quét trước</span>;
  return link
    ? <Link className="scan-row-source" href={`/app/bai-viet?nhu-cau=${scan.profile.id}`} title={scan.profile.name}>{scan.profile.name}</Link>
    : <span className="scan-row-source" title={scan.profile.name}>{scan.profile.name}</span>;
}

/** Back-to-back successful scans without new leads, folded into one muted row: how many, since when, which searches. */
export function QuietScansRow({ scans, when, since, showSource }: { scans: ScanRun[]; when: string; since: string; showSource: boolean }) {
  const names = sourceNames(scans);
  const detail = [scans.length > 1 ? `từ ${since}` : '', showSource ? names.join(', ') : ''].filter(Boolean).join(' · ');
  return <li className="scan-row is-none is-folded">
    <time dateTime={scans[0].scannedAt} title={scanTime(scans[0].scannedAt)}>{when}</time>
    <div className="scan-row-main">
      <p className="scan-row-result">Đã tìm xong{scans.length > 1 ? ` ${scans.length} lượt` : ''} · Chưa có lead mới</p>
      {detail && <span className="scan-row-source is-muted" title={names.join(', ')}>{detail}</span>}
    </div>
  </li>;
}

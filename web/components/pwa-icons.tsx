/** Icons used only by the install / notification UI, drawn in the same 24px stroke style as components/visuals.tsx. */
const paths = {
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 21h4',
  bellOff: 'M3 3l18 18M8.5 5.4A6 6 0 0 1 18 11v4M6 11v5l-1.5 2H17M10 21h4',
  phone: 'M8 2.5h8a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 20V4A1.5 1.5 0 0 1 8 2.5ZM11 18.5h2',
  // Safari's Share glyph: a box with an arrow leaving the top.
  share: 'M12 3v12M8 7l4-4 4 4M7 10H5.5v10.5h13V10H17',
  plusSquare: 'M4 4h16v16H4zM12 8v8M8 12h8',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  close: 'M6 6l12 12M18 6 6 18',
} as const;

export type PwaIconName = keyof typeof paths;

export function PwaIcon({ name, size = 18 }: { name: PwaIconName; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}

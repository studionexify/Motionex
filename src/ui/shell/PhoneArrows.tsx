// Phone only (≤767px, CSS-gated): the canvas starts completely clear. Edge arrows open the tool strip (left) and
// the slice bar (bottom); the settings sheet has its own arrow (right, RightColumn). State lives as body classes so
// the existing floating panels need no changes.
import { useEffect, useState } from 'react';

const chev = (d: string) => <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function PhoneArrows() {
  const [tools, setTools] = useState(false);
  const [slice, setSlice] = useState(false);
  useEffect(() => { document.body.classList.toggle('ph-tools', tools); document.body.classList.toggle('ph-slice', slice); }, [tools, slice]);
  return (
    <>
      <button className={`ph-arrow ph-arrow-left${tools ? ' on' : ''}`} onClick={() => setTools(!tools)} aria-expanded={tools} aria-label={tools ? 'Hide tools' : 'Show tools'}>
        {chev(tools ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5')}
      </button>
      <button className={`ph-arrow ph-arrow-bottom${slice ? ' on' : ''}`} onClick={() => setSlice(!slice)} aria-expanded={slice} aria-label={slice ? 'Hide slice bar' : 'Show slice bar'}>
        {chev(slice ? 'M3 6l5 5 5-5' : 'M3 10l5-5 5 5')}
      </button>
    </>
  );
}

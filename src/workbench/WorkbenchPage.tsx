// React host for the Motionex workbench (the screen Motionex opens on).
import { useEffect, useRef } from 'react';
import { mountWorkbench } from './workbench';
import './workbench.css';

export function WorkbenchPage() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? mountWorkbench(ref.current) : undefined), []);
  return <div ref={ref} className="wb-host" style={{ gridColumn: '1 / -1', minHeight: 0, height: '100%', overflow: 'hidden' }} />;
}

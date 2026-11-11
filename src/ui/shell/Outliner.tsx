// Object outliner: the plate's objects, parts and height ranges, floating beside the tool rail over the 3D view
// (where the objects are), instead of at the bottom of the settings column. Hidden while a tool panel uses that spot.
import { useStore } from '../../state/store';
import { ObjectsCard } from '../Sidebar';

export function Outliner() {
  const tool = useStore((s) => s.tool);
  if (tool !== 'select') return null;
  return <div className="float sh-outliner" aria-label="Objects"><ObjectsCard /></div>;
}

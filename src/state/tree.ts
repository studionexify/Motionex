// Expand / collapse state of the object list rows (settings, height ranges and parts under each object).
import { create } from 'zustand';
import { useStore } from './store';

interface TreeState { collapsed: Record<string, boolean> }
export const useTree = create<TreeState>(() => ({ collapsed: {} }));

export const toggleObjectRow = (id: string) => useTree.setState((t) => ({ collapsed: { ...t.collapsed, [id]: !t.collapsed[id] } }));
export const expandAllObjects = () => useTree.setState({ collapsed: {} });
export const collapseAllObjects = () => useTree.setState({ collapsed: Object.fromEntries(useStore.getState().objects.map((o) => [o.id, true])) });

import type { ReactNode } from 'react';
import { copyItemName, MEOWDB_ITEMS_URL } from '../core/data/osms';
import { toast } from './hooks';

/** A link to meowdb's item list, with the item's name copied for its search. */
export function MeowdbLink({ name, children }: { name: string; children: ReactNode }) {
  return <a href={MEOWDB_ITEMS_URL} target="_blank" rel="noopener" title={`Copy "${name}" and open meowdb's item list (paste it into the search)`}
    onClick={() => copyItemName(name, 'meowdb', toast)}>{children}</a>;
}

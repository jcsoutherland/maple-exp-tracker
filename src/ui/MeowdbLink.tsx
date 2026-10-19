import type { ReactNode } from 'react';
import { copyItemName, MEOWDB_ITEMS_URL, meowdbItemUrl } from '../core/data/osms';
import { toast } from './hooks';

/**
 * A link to an item on meowdb: straight to its page when the mirror's weekly index knows it, else meowdb's item list
 * with the name copied for its search.
 */
export function MeowdbLink({ name, children }: { name: string; children: ReactNode }) {
  const direct = meowdbItemUrl(name);
  return direct
    ? <a href={direct} target="_blank" rel="noopener" title={`${name} on meowdb`}>{children}</a>
    : <a href={MEOWDB_ITEMS_URL} target="_blank" rel="noopener" title={`Copy "${name}" and open meowdb's item list (paste it into the search)`}
        onClick={() => copyItemName(name, 'meowdb', toast)}>{children}</a>;
}

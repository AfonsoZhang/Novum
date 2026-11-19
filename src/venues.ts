import fs from 'node:fs';
import { z } from 'zod';

const venueSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), kind: z.enum(['conference', 'journal']),
  shortName: z.string().trim().min(1), name: z.string().trim().min(1).max(300),
  url: z.string().url().refine(value => new URL(value).protocol === 'https:', 'Official venue links must use HTTPS'),
}).strict();
export const venueCatalogSchema = z.object({
  version: z.literal(1), updatedAt: z.iso.date(), venues: z.array(venueSchema).min(1),
}).strict().superRefine((catalog, ctx) => {
  const ids = new Set<string>(); const urls = new Set<string>();
  for (const venue of catalog.venues) {
    if (ids.has(venue.id) || urls.has(venue.url)) ctx.addIssue({ code: 'custom', message: `Duplicate venue: ${venue.id}` });
    ids.add(venue.id); urls.add(venue.url);
  }
});

/** Packaged alongside the runtime, independent of the process working directory. */
export function venueCatalog() {
  return venueCatalogSchema.parse(JSON.parse(fs.readFileSync(new URL('../config/venues.json', import.meta.url), 'utf8')));
}

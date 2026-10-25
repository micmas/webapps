// Knowledge-base report for the Results view: the browser side of the
// evidence port in packages/calmar/src/kb-evidence.js.
//
// Pipeline stage `kb-report` (orchestrator.runKbReport):
//   1. loadKnowledgeBase()        the aphasia-kb JSON (manifest annotation asset)
//   2. reportAtlasEntries()       which of the mapping's label atlases are hosted
//   3. measureDamage()            warped lesion -> each atlas grid -> labelOverlap rows
//   4. DisconnectomeClient        lesion on the MNI152 1 mm grid -> ENIGMA bundle fractions
//   5. evaluateLesion()           findings, summaries, tracts, therapies (shared package)
//   6. renderKbReport()           three sections in #resultsReport
//
// Everything rendered is a group-level literature association with its
// citation and review provenance. The copy says so wherever a reader could
// mistake it for a prediction about the person on the screen; keep it that way.
import { fetchCacheFirst, loadAtlasFromManifest } from './atlas-loader.js';
import { resampleAffine } from './resample.js';
import { writeNifti1 } from './nifti-writer.js';
import { labelOverlap } from './report-damage.js';
import {
  unitDamage, regionDamage, disconnectionFromFractions, evaluateLesion, reportSettings, DIRECTION_TEXT,
} from './kb-evidence.js';

const KB_CACHE = 'lnm-assets-v1';
const SECTION_IDS = {
  location: 'kbLocationResults', whiteMatter: 'kbWhiteMatterResults', therapy: 'kbTherapyResults',
  provenance: 'kbReportProvenance',
};
const BODY_IDS = { location: 'kbLocationBody', whiteMatter: 'kbWhiteMatterBody', therapy: 'kbTherapyBody' };

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function kbReportConfig(manifest) {
  const config = manifest?.kbReport;
  if (!config || !config.annotationAssetId) throw new Error('manifest.kbReport is missing');
  return config;
}

/** The knowledge base JSON named by manifest.kbReport.annotationAssetId (Cache Storage first). */
export async function loadKnowledgeBase(manifest, { fetchBuffer = null } = {}) {
  const config = kbReportConfig(manifest);
  const entry = (manifest.annotationAssets || []).find((a) => a.id === config.annotationAssetId);
  if (!entry) throw new Error(`Knowledge-base asset not found: ${config.annotationAssetId}`);
  if (entry.supportStatus !== 'supported') throw new Error(`Knowledge-base asset is not supported: ${entry.id}`);
  let buffer;
  if (fetchBuffer) {
    buffer = await fetchBuffer(entry);
  } else {
    const cache = typeof caches !== 'undefined' ? await caches.open(KB_CACHE) : null;
    buffer = await fetchCacheFirst(entry.sourceUrl, entry.cacheKey, cache);
  }
  const kb = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
  if (kb.schemaVersion !== 1) throw new Error(`Unsupported knowledge-base schema ${kb.schemaVersion}`);
  return { kb, entry };
}

/**
 * The mapping's label atlases: `{ name, assetId, entry }` for every name in
 * manifest.kbReport.reportAtlases, with `entry` null when the asset is not
 * hosted (the report then says the atlas was not measured).
 */
export function reportAtlasEntries(manifest) {
  const config = kbReportConfig(manifest);
  return Object.entries(config.reportAtlases || {}).map(([name, assetId]) => {
    const entry = (manifest.atlasAssets || []).find((a) => a.id === assetId && a.supportStatus === 'supported') || null;
    return { name, assetId, entry };
  });
}

export function disconnectomeEntry(manifest) {
  const config = kbReportConfig(manifest);
  const entry = (manifest.atlasAssets || []).find((a) => a.id === config.disconnectomeAssetId && a.supportStatus === 'supported');
  return entry ? { entry, grid: config.disconnectomeGrid } : null;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** Nearest-neighbour copy of a binary lesion onto another grid (both affines voxel -> world). */
export function lesionOnGrid(lesion, dims, affine) {
  const mask = lesion.data instanceof Uint8Array ? lesion.data : Uint8Array.from(lesion.data, (v) => (v > 0 ? 1 : 0));
  const out = resampleAffine(mask, lesion.dims, lesion.affine, dims, affine, 'nearest');
  return out instanceof Uint8Array ? out : Uint8Array.from(out, (v) => (v > 0 ? 1 : 0));
}

/**
 * Overlap rows per atlas name for the knowledge-base mapping. `atlases` are
 * `{ name, atlas }` with `atlas` from loadAtlasFromManifest (data, dims,
 * header.affine, manifestEntry.labels). Atlases the lesion does not touch
 * produce no rows and count as unmeasured, as in the Python report.
 */
export function measureDamage(lesion, atlases) {
  const rowsByAtlas = {};
  const measured = [];
  const unmeasured = [];
  const perAtlas = {};
  for (const { name, atlas } of atlases) {
    const affine = atlas.header.affine;
    const onGrid = lesionOnGrid(lesion, atlas.dims, affine);
    const { rows, totalLesionVoxels } = labelOverlap({
      lesion: onGrid, atlas: atlas.data, dims: atlas.dims, affine, labels: atlas.manifestEntry?.labels || {},
    });
    perAtlas[name] = { rows: rows.length, totalLesionVoxels };
    if (rows.length) {
      rowsByAtlas[name] = rows;
      measured.push(name);
    } else {
      unmeasured.push(name);
    }
  }
  return { rowsByAtlas, measured, unmeasured, perAtlas };
}

/** Binary NIfTI of the lesion on the disconnectome atlas grid (FSL MNI152 1 mm). */
export function disconnectomeLesionNifti(lesion, grid) {
  const dims = grid.dims;
  const affine = grid.affine;
  const mask = lesionOnGrid(lesion, dims, affine);
  let voxels = 0;
  for (let i = 0; i < mask.length; i += 1) voxels += mask[i];
  const nifti = writeNifti1(mask, {
    dims, spacing: [1, 1, 1], affine: [affine[0], affine[1], affine[2]].flat(),
    description: 'CALMaR lesion on the MNI152 1mm disconnectome grid',
  });
  return { buffer: nifti, voxels };
}

export function fractionsByBundle(tracts, fractions) {
  const out = {};
  for (let i = 0; i < tracts.length; i += 1) out[tracts[i]] = fractions[i];
  return out;
}

/** Talks to web/js/disconnectome-worker.js; keeps the atlas open across queries. */
export class DisconnectomeClient {
  constructor(workerUrl, { WorkerClass = globalThis.Worker } = {}) {
    this.workerUrl = workerUrl;
    this.WorkerClass = WorkerClass;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.sentAtlasKeys = new Set();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new this.WorkerClass(this.workerUrl, { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const waiting = this.pending.get(data?.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      if (data.type === 'error') waiting.reject(new Error(data.message));
      else waiting.resolve(data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event?.message || 'disconnectome worker failed');
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
      this.terminate();
    };
    return this.worker;
  }

  /** `{ tracts, fractions }` for a lesion NIfTI; `atlasBytes()` is called only for the first query. */
  async query(lesionBuffer, { atlasKey, atlasBytes }) {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const message = { id, type: 'query', atlasKey, lesion: lesionBuffer };
    const transfer = [lesionBuffer];
    if (!this.sentAtlasKeys.has(atlasKey)) {
      if (typeof atlasBytes !== 'function') throw new Error(`disconnectome: the atlas bytes are needed for the first query of ${atlasKey}`);
      const atlas = await atlasBytes();
      message.atlas = atlas.slice(0);
      transfer.push(message.atlas);
    }
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    worker.postMessage(message, transfer);
    const data = await result;
    this.sentAtlasKeys.add(atlasKey);
    return { tracts: data.tracts, fractions: data.fractions };
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.sentAtlasKeys.clear();
  }
}

/**
 * The whole evaluation from decoded lesion + loaded assets; the orchestrator
 * owns the async loading so it can check the results generation between awaits.
 */
export function evaluateDamage(kb, rowsByAtlas, { fractions = null, settings = null } = {}) {
  const resolved = settings || reportSettings(kb);
  const damage = regionDamage(unitDamage(rowsByAtlas, kb.mapping), kb.mapping);
  const disconnection = fractions ? disconnectionFromFractions(fractions, kb.mapping) : null;
  return evaluateLesion(kb, { damage, disconnection, settings: resolved });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

const pct = (value, digits = 0) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—');
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;

function countsText(counts) {
  const singular = {
    'Associations': 'association', 'Inverse associations': 'inverse association', 'Null findings': 'null finding',
    'Mixed results': 'mixed result', 'Other / unclassified': 'other / unclassified',
  };
  return Object.entries(counts).filter(([, n]) => n)
    .map(([label, n]) => `${n} ${n === 1 ? singular[label] : label.toLowerCase()}`).join(', ');
}

function stars(doc, n, label, score) {
  const glyphs = n ? '★'.repeat(n) : '—';
  return el(doc, 'span', {
    title: `Display heuristic for ordering only, not an evidence grade (raw score ${score >= 0 ? '+' : ''}${score.toFixed(2)})`,
  }, [el(doc, 'span', { 'aria-hidden': 'true', text: glyphs }), ' ', el(doc, 'span', { class: 'nd-report-notes', text: `${n}/4 · ${label}` })]);
}

function findingArticle(doc, kb, finding) {
  const method = Array.isArray(finding.method) ? finding.method.join(', ') : (finding.method || 'Not reported');
  const design = finding.design && String(finding.design) !== String(method) ? ` · ${finding.design}` : '';
  const stages = finding.stages?.length ? finding.stages.join('/') : 'not stated';
  const review = [
    finding.source_status ? `Entry status: ${finding.source_status}` : null,
    finding.review_kind ? `Review provenance: ${{ none: 'no named reviewer', legacy: 'legacy approval' }[finding.review_kind] || finding.review_kind}` : null,
    finding.reviewer ? `Reviewer: ${finding.reviewer}` : null,
    finding.review_tier && finding.review_tier !== 'legacy' ? `Review tier: ${finding.review_tier}` : null,
  ].filter(Boolean).join(' · ');
  const citation = finding.citation || 'Citation not recorded';
  const full = kb.citations?.[finding.citation];
  const more = [];
  if (finding.sample && Object.keys(finding.sample).length) {
    more.push(el(doc, 'p', {}, [el(doc, 'strong', { text: 'Sample: ' }),
      Object.entries(finding.sample).filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join('; ') : v}`).join(' · ')]));
  }
  if (finding.statistics && Object.keys(finding.statistics).length) {
    more.push(el(doc, 'p', {}, [el(doc, 'strong', { text: 'Reported statistics: ' }),
      Object.entries(finding.statistics).filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')]));
  }
  if (finding.author_limitations?.length) {
    more.push(el(doc, 'p', {}, [el(doc, 'strong', { text: 'Author-reported limitations' })]),
      el(doc, 'ul', {}, finding.author_limitations.map((item) => el(doc, 'li', { text: String(item) }))));
  }
  if (finding.flags?.length) {
    more.push(el(doc, 'p', {}, [el(doc, 'strong', { text: 'Extraction flags' })]),
      el(doc, 'ul', {}, finding.flags.map((item) => el(doc, 'li', { text: String(item) }))));
  }
  if (finding.source_passages?.length) {
    more.push(el(doc, 'p', {}, [el(doc, 'strong', { text: 'Source passages' })]),
      ...finding.source_passages.map((passage) => el(doc, 'blockquote', {}, [
        el(doc, 'p', { text: String(passage.quote || '') }),
        el(doc, 'footer', { class: 'nd-report-notes', text: [
          passage.page !== undefined && passage.page !== null ? `page ${passage.page}` : '',
          passage.section || '',
          passage.supports ? `supports ${String(passage.supports).replace(/_/g, ' ')}` : '',
        ].filter(Boolean).join(' · ') }),
      ])));
  }
  return el(doc, 'article', { class: 'kb-finding' }, [
    el(doc, 'p', {}, [el(doc, 'strong', { text: String(finding.claim || '') })]),
    el(doc, 'p', { class: 'nd-report-notes' }, [
      el(doc, 'code', { text: citation }), ` · Study method: ${method}${design} · Relationship: ${DIRECTION_TEXT[finding.direction] || finding.direction || 'Not reported'}`
      + ` · Evidence strength: ${finding.strength || 'Not reported'} · Extraction confidence: ${finding.confidence || 'Not reported'} · Study phase: ${stages}`
      + (review ? ` · ${review}` : ''),
    ]),
    full ? el(doc, 'details', {}, [el(doc, 'summary', { text: `Full citation for ${citation}` }), el(doc, 'p', { text: full })]) : null,
    more.length ? el(doc, 'details', {}, [el(doc, 'summary', { text: 'Study context, limitations, review and source passages' }), ...more]) : null,
  ]);
}

function outcomeBlocks(doc, kb, outcomes) {
  return outcomes.map((group) => el(doc, 'section', {}, [
    el(doc, 'h4', { text: `${group.name} · ${plural(group.findings.length, 'finding')}` }),
    el(doc, 'p', { class: 'nd-report-notes', text: countsText(group.counts) }),
    ...group.findings.map((f) => findingArticle(doc, kb, f)),
  ]));
}

function locationSection(doc, kb, report, result) {
  const { settings, coverage } = report;
  const nodes = [];
  nodes.push(el(doc, 'p', {}, [
    'This section connects the lesion location to published group-level findings about symptoms. Aphasia diagnoses, ',
    'subtype labels and other non-symptom targets are excluded: the report does not infer the presence or type of aphasia ',
    'from a lesion. Start with the symptom summaries, then open a damaged region to inspect each supporting, null or mixed finding.',
  ]));
  nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [
    `A region counts as damaged when it holds ≥${settings.minOverlapPct}% of the lesion or ≥${settings.minRegionPct}% of it is destroyed. `,
    `Regions are matched to the knowledge base through its curated atlas mapping. Of the knowledge base's ${coverage.findings} location findings, `,
    `${report.matchedBeforeFilter} concern regions this lesion damages before the symptom-only display filter; ${report.shown} symptom findings are shown. `,
    `${coverage.undamaged} concern regions it does not damage, and ${coverage.unmappable} concern regions no label atlas can represent.`,
  ]));
  if (report.laterality?.mainlyRight) {
    nodes.push(el(doc, 'p', { class: 'nd-message warning', role: 'note' }, [
      el(doc, 'strong', { text: 'Caution: ' }),
      'this lesion lies mainly in the right hemisphere. The knowledge base is almost entirely about left-hemisphere language regions, ',
      'so few or no findings apply; an absence of findings here does not mean an absence of deficits.',
    ]));
  }
  if (!report.summaries.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'No knowledge-base findings concern the damaged regions.' })]));
    return nodes;
  }
  const primary = report.summaries.filter((s) => s.primary);
  const additional = report.summaries.filter((s) => !s.primary);
  const summaryTable = (rows) => el(doc, 'div', { class: 'nd-table-scroll' }, [
    el(doc, 'table', { class: 'nd-data-table kb-symptom-table' }, [
      el(doc, 'thead', {}, [el(doc, 'tr', {}, [
        el(doc, 'th', { text: 'Display signal' }), el(doc, 'th', { text: 'Symptom target' }),
        el(doc, 'th', { class: 'nd-numeric', text: 'Findings' }), el(doc, 'th', { text: 'Relationships' }),
        el(doc, 'th', { text: 'Implicated regions' }), el(doc, 'th', { text: 'Citations' }),
      ])]),
      el(doc, 'tbody', {}, rows.map((s) => el(doc, 'tr', { 'data-target': s.target }, [
        el(doc, 'td', {}, [stars(doc, s.stars, s.strengthLabel, s.score)]),
        el(doc, 'td', {}, [el(doc, 'strong', { text: s.name }), ' ', el(doc, 'span', { class: 'nd-report-notes', text: `(${s.kind})` })]),
        el(doc, 'td', { class: 'nd-numeric', text: String(s.distinct) }),
        el(doc, 'td', { text: countsText(s.counts) }),
        el(doc, 'td', { text: s.regions.join(', ') }),
        el(doc, 'td', {}, s.citations.map((c, i) => el(doc, 'span', {}, [i ? ', ' : '', el(doc, 'code', { title: kb.citations?.[c] || '', text: c })]))),
      ]))),
    ]),
  ]);
  nodes.push(el(doc, 'details', {}, [
    el(doc, 'summary', { text: 'What does the display signal mean?' }),
    el(doc, 'p', { class: 'nd-report-notes' }, [
      el(doc, 'strong', { text: 'Project-specific display heuristic, not an evidence grade. ' }),
      'It only orders these summaries: the share of each matched region damaged, combined with the stored finding strength, ',
      'study evidence class, extraction confidence and relationship direction. Finding counts do not measure certainty, and ',
      'findings may come from the same study or overlapping cohorts. A symptom is listed first when its findings span at least ',
      `${settings.minSummaryCitations} citation keys and ${settings.minSummaryAnatomies} anatomy mappings; this is a scanning rule, not a certainty threshold.`,
    ]),
  ]));
  nodes.push(el(doc, 'p', { class: 'nd-report-notes', text: `${plural(report.summaries.length, 'symptom summary', 'symptom summaries')} · group associations, not a participant-level prediction.` }));
  if (primary.length) nodes.push(summaryTable(primary));
  else nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'No symptom summary meets the primary display criterion; the matched summaries are listed below.' })]));
  if (additional.length) {
    nodes.push(el(doc, 'details', {}, [
      el(doc, 'summary', { text: `Show ${plural(additional.length, 'symptom summary', 'symptom summaries')} below the primary display criterion` }),
      summaryTable(additional),
    ]));
  }
  const regionBlock = (r) => el(doc, 'details', { class: 'kb-region', 'data-region': r.region }, [
    el(doc, 'summary', {}, [
      el(doc, 'strong', { text: `${r.name} (${r.side})` }),
      ` — ${pct(r.lesion_pct, 1)} of the lesion` + (typeof r.region_pct === 'number' ? ` · ${pct(r.region_pct)} of the region destroyed` : '')
      + ` · ${plural(r.distinct, 'distinct finding')}`
      + (r.judgementCall ? ' · atlas match includes a documented judgement call' : '')
      + (r.thin !== null ? ` · limited citation base (${plural(r.thin, 'citation key')})` : ''),
    ]),
    r.synonyms.length ? el(doc, 'p', { class: 'nd-report-notes', text: `Also recorded in the knowledge base as: ${r.synonyms.join(', ')}` }) : null,
    ...outcomeBlocks(doc, kb, r.outcomes),
  ]);
  const main = report.regions.slice(0, Math.max(1, settings.maxEvidenceRegions));
  const rest = report.regions.slice(main.length);
  nodes.push(el(doc, 'h4', { text: 'Evidence by damaged region' }));
  nodes.push(el(doc, 'p', { class: 'nd-report-notes', text:
    `The ${plural(main.length, 'main mapped region')} below are ranked by the share of this lesion they contain, then by the share destroyed. `
    + 'Open one to inspect distinct findings grouped by outcome. All qualifying regions contribute to the summaries above; '
    + `a limited citation base means ${settings.thinStudies} citation keys or fewer and is not a certainty rating.` }));
  nodes.push(...main.map(regionBlock));
  if (rest.length) {
    nodes.push(el(doc, 'details', {}, [
      el(doc, 'summary', { text: `Show ${plural(rest.length, 'additional qualifying damaged region')}` }), ...rest.map(regionBlock),
    ]));
  }
  void result;
  return nodes;
}

function whiteMatterSection(doc, kb, report, { disconnectomeLabel, bundles }) {
  const { settings } = report;
  const nodes = [];
  nodes.push(el(doc, 'p', {}, [
    'White-matter tracts that may be interrupted beyond the visible lesion, with any group-level findings linked to them. ',
    'Open a tract to inspect its anatomical context and findings.',
  ]));
  nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [
    `The warped lesion was scored against the ${disconnectomeLabel} (${bundles} bundles) with nii2tvx, the Disconnectome webapp's engine: `,
    'for each bundle, the fraction of its streamlines that pass through the lesion. A tract counts as disconnected when ',
    `≥${settings.minDisconnectedPct}% of its streamlines do; the knowledge-base tract regions take the largest fraction of their bundles. `,
    'Direct tract damage from the JHU and XTRACT label atlases, when those are hosted, is reported in the lesion-location section above. ',
    'A cross-reference means the same symptom target also has direct-damage evidence from a different anatomy; it is not independent or additive evidence.',
  ]));
  if (report.message) nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: report.message })]));
  const tractBlock = (t) => el(doc, 'details', { class: 'kb-tract', 'data-region': t.region }, [
    el(doc, 'summary', {}, [
      el(doc, 'strong', { text: `${t.name} (${t.side})` }),
      ` — ${pct(t.region_pct)} of the tract's streamlines pass through the lesion`
      + (t.directlyDamagedPct !== null ? ` · also directly damaged (${pct(t.directlyDamagedPct)} destroyed)` : '')
      + ` · ${plural(t.distinct, 'distinct finding')} · ${countsText(t.counts)}`
      + (t.thin !== null ? ` · limited citation base (${plural(t.thin, 'citation key')})` : ''),
    ]),
    t.synonyms.length ? el(doc, 'p', { class: 'nd-report-notes', text: `Also recorded in the knowledge base as: ${t.synonyms.join(', ')}` }) : null,
    t.shared.length ? el(doc, 'p', { class: 'nd-report-notes' }, [
      el(doc, 'strong', { text: 'Same symptom targets also listed under direct damage elsewhere: ' }),
      t.shared.map((s) => `${s.name} (this tract: ${countsText(s.tractCounts)}; direct damage elsewhere: ${countsText(s.directCounts)})`).join('; '),
      '. These cross-reference target labels; they do not make the two evidence paths independent or additive.',
    ]) : null,
    ...outcomeBlocks(doc, kb, t.outcomes),
  ]);
  nodes.push(...report.tracts.map(tractBlock));
  if (report.anatomyOnly.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [
      el(doc, 'strong', { text: 'Additional disconnected tracts: ' }),
      'these cross the same threshold but have no eligible symptom-level finding in the current knowledge base. ',
      'Absence of a linked finding is not evidence that a tract has no functional importance.',
    ]));
    nodes.push(el(doc, 'div', { class: 'nd-table-scroll' }, [el(doc, 'table', { class: 'nd-data-table kb-tract-table' }, [
      el(doc, 'thead', {}, [el(doc, 'tr', {}, [el(doc, 'th', { class: 'nd-numeric', text: 'Streamlines through lesion' }), el(doc, 'th', { text: 'Tract' }), el(doc, 'th', { text: 'Side' }), el(doc, 'th', { text: 'Direct damage' })])]),
      el(doc, 'tbody', {}, report.anatomyOnly.map((t) => el(doc, 'tr', { 'data-region': t.region }, [
        el(doc, 'td', { class: 'nd-numeric', text: pct(t.region_pct) }),
        el(doc, 'td', { text: t.synonyms.length ? `${t.name} (also: ${t.synonyms.join(', ')})` : t.name }),
        el(doc, 'td', { text: t.side }),
        el(doc, 'td', { text: t.directlyDamagedPct !== null ? `${pct(t.directlyDamagedPct)} destroyed` : '—' }),
      ]))),
    ])]));
  }
  return nodes;
}

function therapySection(doc, kb, therapies) {
  const nodes = [];
  nodes.push(el(doc, 'p', {}, [
    'Therapies with knowledge-base evidence targeting the symptom-level impairments the lesion location points to. ',
    'They are research associations drawn from the lesion alone, not prescriptions: no behavioural assessment, aphasia type ',
    'or recovery stage enters this webapp, and all of those weigh more than lesion location in the full CALMaR report.',
  ]));
  if (!therapies.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'No therapy entry matched the impairments the damaged regions point to.' })]));
    return nodes;
  }
  nodes.push(el(doc, 'div', { class: 'nd-table-scroll' }, [el(doc, 'table', { class: 'nd-data-table kb-therapy-table' }, [
    el(doc, 'thead', {}, [el(doc, 'tr', {}, [
      el(doc, 'th', { class: 'nd-numeric', text: 'Match' }), el(doc, 'th', { text: 'Therapy' }), el(doc, 'th', { text: 'Addresses impairment(s)' }),
      el(doc, 'th', { text: 'Active ingredients (RTSS)' }), el(doc, 'th', { text: 'Brief description' }), el(doc, 'th', { text: 'Evidence stage' }), el(doc, 'th', { text: 'Citations' }),
    ])]),
    el(doc, 'tbody', {}, therapies.map((t) => {
      const description = t.short_description.length > 160 ? `${t.short_description.slice(0, 160)}…` : t.short_description;
      return el(doc, 'tr', { 'data-therapy': t.therapy_id }, [
        el(doc, 'td', { class: 'nd-numeric', title: 'Number of matched impairments, weighted (explicit therapy→impairment findings count double)', text: String(t.score) }),
        el(doc, 'td', {}, [el(doc, 'strong', { text: t.therapy_name })]),
        el(doc, 'td', { text: t.lesion_names.join(', ') || '—' }),
        el(doc, 'td', { text: t.ingredients.map((i) => (i.category ? `${i.name} (${i.category.replace(/_/g, ' ')})` : i.name)).join(', ') || '—' }),
        el(doc, 'td', { text: description }),
        el(doc, 'td', { text: t.evidenceStages.length ? t.evidenceStages.join(' / ') : 'not stated' }),
        el(doc, 'td', {}, t.citations.map((c, i) => el(doc, 'span', {}, [i ? ', ' : '', el(doc, 'code', { title: kb.citations?.[c] || '', text: c })]))),
      ]);
    })),
  ])]));
  return nodes;
}

function provenanceText(kb, context) {
  const v = kb.version || {};
  const entries = v.entries || {};
  const version = v.commit ? `version ${v.commit} (${v.date})` : `content digest ${v.contentDigest || 'unknown'}`;
  const parts = [
    `Knowledge base ${version}, exported ${v.exportedOn || 'n/a'}: ${v.papers ?? '?'} papers, ${v.findings ?? '?'} extracted findings `
    + `(${v.findingsReviewed ?? '?'} approved by a named reviewer) in ${Object.values(entries).reduce((a, b) => a + b, 0)} entries `
    + `(${entries.regions ?? 0} regions, ${entries.impairments ?? 0} impairments, ${entries.therapies ?? 0} therapies, ${entries.predictors ?? 0} predictors); `
    + `statuses used: ${(v.statuses || []).join(', ')}.`,
  ];
  if (context.measured?.length) parts.push(`Label atlases measured: ${context.measured.join(', ')}.`);
  if (context.unmeasured?.length) parts.push(`Not measured: ${context.unmeasured.join(', ')} (${context.unmeasuredReason || 'no lesion voxels in a labelled region'}).`);
  if (context.missingAtlases?.length) parts.push(`Not hosted in this build: ${context.missingAtlases.join(', ')}; their knowledge-base units are reported as not measured.`);
  parts.push(context.disconnectomeNote || 'Disconnectome: not computed.');
  parts.push('The lesion was registered to MNI space by SynthMorph and the atlases are matched by world coordinates; overlaps depend on how well '
    + 'this brain was registered, which matters most for small or thin regions. Research use only, not a diagnosis.');
  return parts.join(' ');
}

/** Render the three sections (and the provenance line) into the Results report. */
export function renderKbReport(doc, result, { kb, context = {} }) {
  const body = (key) => doc.getElementById(BODY_IDS[key]);
  const section = (key) => doc.getElementById(SECTION_IDS[key]);
  const fill = (key, nodes) => {
    const target = body(key);
    if (!target) return;
    target.replaceChildren(...nodes);
    section(key)?.classList.remove('hidden');
  };
  fill('location', locationSection(doc, kb, result.location, result));
  if (result.whiteMatter) {
    fill('whiteMatter', whiteMatterSection(doc, kb, result.whiteMatter, {
      disconnectomeLabel: context.disconnectomeLabel || 'ENIGMA Symmetric tractography atlas', bundles: context.bundles ?? 65,
    }));
  } else {
    const target = body('whiteMatter');
    if (target) {
      target.replaceChildren(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', {
        text: context.disconnectomeError
          ? `The disconnectome could not be computed: ${context.disconnectomeError}`
          : 'The disconnectome was not computed for this lesion.',
      })]));
      section('whiteMatter')?.classList.remove('hidden');
    }
  }
  fill('therapy', therapySection(doc, kb, result.therapy));
  const provenance = doc.getElementById(SECTION_IDS.provenance);
  if (provenance) {
    provenance.textContent = provenanceText(kb, context);
    provenance.classList.remove('hidden');
  }
}

export function clearKbReport(doc) {
  for (const key of Object.keys(BODY_IDS)) {
    doc.getElementById(BODY_IDS[key])?.replaceChildren();
    doc.getElementById(SECTION_IDS[key])?.classList.add('hidden');
  }
  const provenance = doc.getElementById(SECTION_IDS.provenance);
  if (provenance) {
    provenance.textContent = '';
    provenance.classList.add('hidden');
  }
}

export { SECTION_IDS as KB_SECTION_IDS, BODY_IDS as KB_BODY_IDS };

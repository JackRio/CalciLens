import { useState } from 'react'
import type { LabelColor, ScoringSetup, VolumeInfo } from '../types'
import { AGATSTON_PAPER_URL, AGATSTON_REFERENCE_SPACING_MM, DEFAULT_MIN_LESION_AREA_MM2, labelsFromColors } from '../types'

// The setup a scan starts with: what its file says, the usual label table, and
// any label the mask uses that the table doesn't know about (so it isn't
// silently left out of the scores).
export function initialScoringSetup(
  ctInfo: VolumeInfo,
  maskInfo: VolumeInfo | null,
  maskColors: LabelColor[],
  contrast: boolean,
  thresholdHu: number | null,
): ScoringSetup {
  const acq = ctInfo.acquisition
  // The table starts as the label set in use (Settings ▸ Label colors), plus any
  // label the mask has that the set lacks, so nothing is silently left unscored.
  const labels = labelsFromColors(maskColors)
  for (const label of maskInfo?.labels ?? []) {
    if (!labels.some((l) => l.label === label)) labels.push({ label, name: `Label ${label}`, coronary: false })
  }
  return {
    metric: contrast ? 'volume' : 'agatston',
    sliceSpacingMm: acq?.slice_spacing_mm ?? null,
    sliceThicknessMm: acq?.slice_thickness_mm ?? null,
    kvp: acq?.kvp ?? null,
    kernel: acq?.kernel ?? null,
    source: acq?.source ?? 'image',
    minLesionAreaMm2: DEFAULT_MIN_LESION_AREA_MM2,
    thresholdHu: contrast ? thresholdHu : null,
    labels,
    confirmedAt: '',
  }
}

const toNumber = (v: string): number | null => {
  const n = Number(v.replace(',', '.'))
  return v.trim() !== '' && Number.isFinite(n) ? n : null
}

export default function ScoringSetupModal({
  ctInfo,
  initial,
  editOnly,
  onConfirm,
  onCancel,
}: {
  ctInfo: VolumeInfo
  initial: ScoringSetup
  // Opened from the gear: nothing to carry on with afterwards, just save.
  editOnly?: boolean
  onConfirm: (setup: ScoringSetup) => void
  onCancel: () => void
}) {
  const volume = initial.metric === 'volume'
  const acq = ctInfo.acquisition
  const [spacing, setSpacing] = useState(initial.sliceSpacingMm !== null ? String(initial.sliceSpacingMm) : '')
  const [thickness, setThickness] = useState(initial.sliceThicknessMm !== null ? String(initial.sliceThicknessMm) : '')
  const [minArea, setMinArea] = useState(String(initial.minLesionAreaMm2))
  const [labels, setLabels] = useState<{ label: string; name: string; coronary: boolean }[]>(
    initial.labels.map((l) => ({ label: String(l.label), name: l.name, coronary: l.coronary })),
  )

  const spacingValue = toNumber(spacing)
  const minAreaValue = toNumber(minArea)
  const parsedLabels = labels.map((l) => ({ label: toNumber(l.label), name: l.name.trim(), coronary: l.coronary }))
  const numbers = parsedLabels.map((l) => l.label)

  let problem: string | null = null
  if (!volume && (spacingValue === null || spacingValue <= 0)) problem = 'Enter the slice spacing.'
  else if (!volume && (minAreaValue === null || minAreaValue < 0)) problem = 'Minimum lesion area must be 0 or more.'
  else if (parsedLabels.length === 0) problem = 'Add at least one label.'
  else if (parsedLabels.some((l) => l.label === null || !Number.isInteger(l.label) || l.label <= 0))
    problem = 'Label numbers must be whole numbers above 0.'
  else if (new Set(numbers).size !== numbers.length) problem = 'Each label number can appear once.'
  else if (parsedLabels.some((l) => !l.name || l.name.toUpperCase() === 'CAC'))
    problem = 'Give each label a name (CAC is the coronary total).'
  else if (new Set(parsedLabels.map((l) => l.name)).size !== parsedLabels.length) problem = 'Each name can appear once.'

  const notes: string[] = []
  if (!volume) {
    if (acq?.non_uniform_spacing)
      notes.push(`The slices are not evenly spaced (up to ${acq.spacing_variation_mm.toFixed(1)} mm off). The score will be approximate.`)
    if (acq?.kvp === null || acq?.kvp === undefined) {
      if (acq?.source === 'dicom') notes.push('Tube voltage is not in the file. The 130 HU cut-off assumes 120 kVp.')
    } else if (acq.kvp !== 120) {
      notes.push(`Scanned at ${acq.kvp} kVp. The 130 HU cut-off assumes 120 kVp.`)
    }
  }

  function confirm() {
    if (problem) return
    onConfirm({
      ...initial,
      sliceSpacingMm: volume ? initial.sliceSpacingMm : spacingValue,
      sliceThicknessMm: toNumber(thickness),
      minLesionAreaMm2: minAreaValue ?? DEFAULT_MIN_LESION_AREA_MM2,
      labels: parsedLabels.map((l) => ({ label: l.label as number, name: l.name, coronary: l.coronary })),
      confirmedAt: new Date().toISOString(),
    })
  }

  function updateRow(i: number, patch: Partial<(typeof labels)[number]>) {
    setLabels(labels.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }

  return (
    <div className="comment-modal-backdrop" onClick={onCancel}>
      <div className="comment-modal scoring-modal" onClick={(e) => e.stopPropagation()}>
        <div className="comment-modal-title">{editOnly || initial.confirmedAt ? 'Scoring setup' : 'Before scoring this scan'}</div>

        {volume ? (
          <div className="nav-modal-body">
            {initial.thresholdHu !== null
              ? `Volumes are measured above this scan's own threshold, ${initial.thresholdHu.toFixed(0)} HU.`
              : "Volumes are measured above this scan's own threshold."}
          </div>
        ) : (
          <div className="scoring-fields">
            <label>
              Slice spacing (mm)
              <input value={spacing} onChange={(e) => setSpacing(e.target.value)} />
              <span className={spacingValue === null ? 'scoring-hint scoring-hint-needed' : 'scoring-hint'}>
                {spacingValue === null ? 'needed' : acq?.source === 'dicom' ? 'from DICOM' : 'from the image'}
              </span>
            </label>
            <label>
              Slice thickness (mm)
              <input value={thickness} onChange={(e) => setThickness(e.target.value)} placeholder="optional" />
              <span className="scoring-hint">{acq?.slice_thickness_mm != null ? 'from DICOM' : 'not in this file'}</span>
            </label>
            <label>
              Minimum lesion area (mm²)
              <input value={minArea} onChange={(e) => setMinArea(e.target.value)} />
              <span className="scoring-hint">per slice</span>
            </label>
            <div className="scoring-summary">
              {acq?.kvp ? `${acq.kvp} kVp` : 'kVp unknown'}
              {acq?.kernel ? ` · kernel ${acq.kernel}` : ''} · threshold 130 HU
            </div>
          </div>
        )}
        {notes.map((n) => (
          <div key={n} className="scoring-note">
            {n}
          </div>
        ))}

        <div className="scoring-labels">
          <div className="scoring-labels-head">
            <span>Label</span>
            <span>Name</span>
            <span title="Counts towards the coronary total (CAC)">CAC</span>
            <span />
          </div>
          <div className="scoring-labels-rows">
          {labels.map((l, i) => (
            <div className="scoring-labels-row" key={i}>
              <input value={l.label} onChange={(e) => updateRow(i, { label: e.target.value })} />
              <input value={l.name} onChange={(e) => updateRow(i, { name: e.target.value })} />
              <input type="checkbox" checked={l.coronary} onChange={(e) => updateRow(i, { coronary: e.target.checked })} />
              <button type="button" onClick={() => setLabels(labels.filter((_, j) => j !== i))} title="Remove">
                ✕
              </button>
            </div>
          ))}
          </div>
          <button
            type="button"
            className="scoring-add"
            onClick={() => {
              const next = Math.max(0, ...numbers.map((n) => n ?? 0)) + 1
              setLabels([...labels, { label: String(next), name: `Label ${next}`, coronary: false }])
            }}
          >
            + Add label
          </button>
        </div>

        {!volume && (
          <div className="scoring-note scoring-method">
            Calcium is scored with the clinical standard: Agatston method, 130 HU, scaled to {AGATSTON_REFERENCE_SPACING_MM} mm slices (
            <a href={AGATSTON_PAPER_URL} target="_blank" rel="noreferrer">
              Agatston et al., 1990
            </a>
            ).
          </div>
        )}
        {problem && <div className="scoring-note scoring-note-error">{problem}</div>}

        <div className="comment-modal-buttons">
          <button onClick={onCancel}>Cancel</button>
          <button className="add-label-btn" onClick={confirm} disabled={!!problem}>
            {editOnly || initial.confirmedAt ? 'Save' : 'Score'}
          </button>
        </div>
      </div>
    </div>
  )
}

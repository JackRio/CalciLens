import type { ManifestRow, PaneState } from '../types'
import { DEFAULT_MANIFEST_CONFIG } from '../types'
import { getManifestColumns, getManifestPairs } from '../api'
import { IMAGE_FILE_FILTERS, isElectron, pickPath } from '../electronApi'

// The optional column pickers all look identical: a select over the
// manifest's real columns with an explicit "none" option, falling back to a
// free-text box before a manifest has been read.
function ColumnPicker({
  label,
  title,
  value,
  placeholder,
  columns,
  onChange,
}: {
  label: string
  title: string
  value: string
  placeholder: string
  columns: string[]
  onChange: (next: string) => void
}) {
  return (
    <label title={title}>
      {label}
      {columns.length > 0 ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">-- none --</option>
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : (
        <input type="text" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  )
}

const MANIFEST_FILTERS = [
  { name: 'CSV / Excel', extensions: ['csv', 'xlsx', 'xls', 'xlsm'] },
  { name: 'All files', extensions: ['*'] },
]

export default function CaseLoader({
  pane,
  onChange,
  onLoadCt,
  onLoadMask,
  annotationSaveDir,
  onAnnotationSaveDirChange,
  onRequestSelectRow,
  onLoadRow,
  hasUnsavedMaskChanges,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onLoadCt: (path: string) => Promise<void>
  onLoadMask: (path: string) => Promise<void>
  annotationSaveDir: string
  onAnnotationSaveDirChange: (next: string) => void
  // Routed through Pane so picking a case from this dropdown gets the same
  // unsaved-work prompt Prev/Next gets. It used to load straight over the
  // top with no prompt at all.
  onRequestSelectRow: (rowIndex: number) => void
  onLoadRow: (row: ManifestRow) => void
  hasUnsavedMaskChanges: boolean
}) {
  const electronAvailable = isElectron()

  const cfg = pane.manifestConfig
  const availableColumns = pane.manifestColumns

  function updateConfig(partial: Partial<typeof cfg>) {
    onChange({ manifestConfig: { ...cfg, ...partial } })
  }

  async function handleBrowseCtFile() {
    const picked = await pickPath({ properties: ['openFile'], filters: IMAGE_FILE_FILTERS })
    if (picked) onChange({ ctPath: picked })
  }

  async function handleBrowseCtFolder() {
    const picked = await pickPath({ properties: ['openDirectory'] })
    if (picked) onChange({ ctPath: picked })
  }

  async function handleBrowseMaskFile() {
    const picked = await pickPath({ properties: ['openFile'], filters: IMAGE_FILE_FILTERS })
    if (picked) onChange({ maskPath: picked })
  }

  async function handleBrowseManifest() {
    const picked = await pickPath({ properties: ['openFile'], filters: MANIFEST_FILTERS })
    if (picked) {
      // Pass the just-picked path (and the config it belongs on) explicitly
      // instead of relying on the `cfg` closure — by the time the async
      // column fetch below resolves, `cfg` here is stale (captured at this
      // render), so reading it after the await would silently drop this
      // manifestPath update.
      tryDetectColumns(picked, { ...cfg, manifestPath: picked })
    }
  }

  async function tryDetectColumns(path: string, baseConfig: typeof cfg) {
    try {
      const cols = await getManifestColumns(path)
      onChange({ manifestColumns: cols })

      // The select shows whichever column the underlying config value
      // matches, but a case-mismatch (e.g. default "PatientId" vs. an actual
      // "PatientID" column) makes the browser silently fall back to
      // displaying the first <option> while the real config value stays
      // wrong — so the dropdown *looks* correct but submits the stale value.
      // Reconcile every configured column name against what's actually in
      // the file (case-insensitively) so what's shown is what gets sent.
      // Mask/Patient ID are optional: when nothing matches, resolve to ''
      // (the explicit "-- none --" option) rather than leaving a stale
      // value that isn't in `cols` — that stale value is what previously
      // made the dropdown silently display the first real column instead.
      const resolve = (current: string, keywords: string[], optional: boolean) => {
        if (cols.includes(current)) return current
        const ci = cols.find((c) => c.toLowerCase() === current.toLowerCase())
        if (ci) return ci
        const byKeyword = cols.find((c) => keywords.some((k) => c.toLowerCase().includes(k)))
        if (byKeyword) return byKeyword
        return optional ? '' : current
      }
      onChange({
        manifestConfig: {
          ...baseConfig,
          imageColumn: resolve(baseConfig.imageColumn, ['image', 'ct_path', 'img'], false),
          maskColumn: resolve(baseConfig.maskColumn, ['mask', 'seg'], true),
          patientIdColumn: resolve(baseConfig.patientIdColumn, ['patient'], true),
          reasonColumn: resolve(baseConfig.reasonColumn, ['reason'], true),
          statusColumn: resolve(baseConfig.statusColumn, ['status'], true),
          // optional=false: keep the default name when the manifest has no
          // such column yet, so the backend creates it. Resolving to "none"
          // would leave saved annotations with nowhere to be recorded.
          annotationColumn: resolve(baseConfig.annotationColumn, ['annotation'], false),
          contrastColumn: resolve(baseConfig.contrastColumn, ['contrast'], false),
        },
      })
    } catch {
      onChange({ manifestColumns: [], manifestConfig: baseConfig })
    }
  }

  // Loads a manifest row through App's loadRowIntoPane — the same path
  // Previous/Next uses. It used to call onLoadCt/onLoadMask directly, which
  // meant the first case after loading a manifest took a different route
  // from every subsequent one: it loaded the original prediction even when a
  // saved annotation existed, and skipped the CT/mask geometry check.
  function selectRow(row: ManifestRow) {
    onLoadRow(row)
  }

  async function handleLoadManifest() {
    onChange({
      manifestError: null,
      manifestRows: [],
      activeRowIndex: null,
      reasonOptions: [],
      scoreClasses: [],
      loading: true,
      loadingMessage: 'Loading manifest...',
    })
    try {
      const { rows, reasonOptions, statusOptions, scoreClasses, hasAnnotationColumn, hasContrastColumn } =
        await getManifestPairs({
          manifestPath: cfg.manifestPath,
          imageColumn: cfg.imageColumn,
          maskColumn: cfg.maskColumn,
          patientIdColumn: cfg.patientIdColumn,
          reasonColumn: cfg.reasonColumn,
          includeDefaultReasonTags: cfg.includeDefaultReasonTags,
          statusColumn: cfg.statusColumn,
          annotationColumn: cfg.annotationColumn,
          contrastColumn: cfg.contrastColumn,
        })
      onChange({
        manifestRows: rows,
        reasonOptions,
        statusOptions,
        scoreClasses,
        hasAnnotationColumn,
        hasContrastColumn,
      })
      if (rows.length === 0) {
        onChange({ loading: false, loadingMessage: null, manifestError: 'Manifest loaded but no valid rows found (check the image column has paths).' })
      } else {
        selectRow(rows[0])
      }
    } catch (e) {
      onChange({ loading: false, loadingMessage: null, manifestError: e instanceof Error ? e.message : String(e) })
    }
  }

  function handleSelectRow(indexStr: string) {
    const idx = Number(indexStr)
    if (pane.manifestRows.some((r) => r.index === idx)) onRequestSelectRow(idx)
  }

  // Loading a single scan/mask should leave the manifest behind entirely (no
  // stale "N / M" counter from whatever manifest happened to be loaded
  // before) — but this can't live inside onLoadCt/onLoadMask themselves,
  // since manifest row navigation (selectRow above, and App.tsx's
  // loadRowIntoPane) also calls those and must NOT clear the manifest it's
  // actively iterating.
  async function handleLoadCtSingle() {
    if (hasUnsavedMaskChanges && !window.confirm('This pane has unsaved annotation changes. Loading a different scan will discard them. Continue?')) {
      return
    }
    onChange({ manifestRows: [], activeRowIndex: null, reasonOptions: [], scoreClasses: [], manifestError: null })
    await onLoadCt(pane.ctPath)
  }

  async function handleLoadMaskSingle() {
    if (hasUnsavedMaskChanges && !window.confirm('This pane has unsaved annotation changes. Loading a different mask will discard them. Continue?')) {
      return
    }
    onChange({ manifestRows: [], activeRowIndex: null, reasonOptions: [], scoreClasses: [], manifestError: null })
    await onLoadMask(pane.maskPath)
  }

  return (
    <div className="settings-section case-loader">
      <div className="settings-title">Load a single scan</div>
      <label>
        CT file path
        <div className="inline-row">
          <input
            type="text"
            placeholder="e.g. D:\\data\\CASE001\\CASE001_ST3.nii.gz"
            value={pane.ctPath}
            onChange={(e) => onChange({ ctPath: e.target.value })}
          />
          {electronAvailable && <button onClick={handleBrowseCtFile}>Browse file...</button>}
          {electronAvailable && (
            <button onClick={handleBrowseCtFolder} title="Pick a folder of DICOM slices">
              Browse DICOM dir...
            </button>
          )}
          <button onClick={handleLoadCtSingle}>Load CT</button>
        </div>
      </label>
      <label>
        Mask file path
        <div className="inline-row">
          <input
            type="text"
            placeholder="mask path (nii.gz / mha / dicom dir)"
            value={pane.maskPath}
            onChange={(e) => onChange({ maskPath: e.target.value })}
          />
          {electronAvailable && <button onClick={handleBrowseMaskFile}>Browse file...</button>}
          <button onClick={handleLoadMaskSingle}>Load mask</button>
        </div>
      </label>
      <label>
        Save folder
        <div className="inline-row">
          <input
            type="text"
            placeholder="(default) save next to the image"
            value={annotationSaveDir}
            onChange={(e) => onAnnotationSaveDirChange(e.target.value)}
            title="Annotations (and, in contrast mode, seed sidecars) save into <this>/Manual_Annotations/<scan>/ instead of next to the image. Pointing this straight at an existing Manual_Annotations folder works too — it won't nest another one inside."
          />
          {electronAvailable && (
            <button
              onClick={async () => {
                const picked = await pickPath({ properties: ['openDirectory'] })
                if (picked) onAnnotationSaveDirChange(picked)
              }}
            >
              Browse folder...
            </button>
          )}
          {annotationSaveDir && <button onClick={() => onAnnotationSaveDirChange('')}>Clear</button>}
        </div>
      </label>

      <div className="settings-title batch-load-header" style={{ marginTop: 10 }}>
        <button
          className="collapse-toggle"
          onClick={() => onChange({ batchLoadCollapsed: !pane.batchLoadCollapsed })}
          title={pane.batchLoadCollapsed ? 'Expand' : 'Collapse'}
        >
          {pane.batchLoadCollapsed ? '▸' : '▾'}
        </button>
        <span>Batch Load</span>
      </div>

      {!pane.batchLoadCollapsed && (
        <>
          <label>
            Manifest file
            <div className="inline-row">
              <input
                type="text"
                placeholder="e.g. D:\\data\\cases.xlsx"
                value={cfg.manifestPath}
                onChange={(e) => updateConfig({ manifestPath: e.target.value })}
              />
              {electronAvailable && <button onClick={handleBrowseManifest}>Browse...</button>}
              <button
                className="add-label-btn"
                onClick={handleLoadManifest}
                disabled={!cfg.manifestPath}
              >
                Load manifest
              </button>
            </div>
          </label>

          <div className="manifest-columns-row">
            <label>
              Image path column
              {availableColumns.length > 0 ? (
                <select value={cfg.imageColumn} onChange={(e) => updateConfig({ imageColumn: e.target.value })}>
                  {availableColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={cfg.imageColumn}
                  onChange={(e) => updateConfig({ imageColumn: e.target.value })}
                />
              )}
            </label>
            <label>
              Mask path column
              {availableColumns.length > 0 ? (
                <select value={cfg.maskColumn} onChange={(e) => updateConfig({ maskColumn: e.target.value })}>
                  <option value="">-- none --</option>
                  {availableColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={cfg.maskColumn}
                  onChange={(e) => updateConfig({ maskColumn: e.target.value })}
                />
              )}
            </label>
            <label>
              Patient ID column
              {availableColumns.length > 0 ? (
                <select
                  value={cfg.patientIdColumn}
                  onChange={(e) => updateConfig({ patientIdColumn: e.target.value })}
                >
                  <option value="">-- none --</option>
                  {availableColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="e.g. PatientId"
                  value={cfg.patientIdColumn}
                  onChange={(e) => updateConfig({ patientIdColumn: e.target.value })}
                />
              )}
            </label>
            <label>
              <span className="reason-column-label">
                Reason column
                <label
                  className="reason-defaults-toggle"
                  title="Merge the app's built-in tag set (Mislabel, Artefacts, etc.) into the Reason picker's options, alongside whatever tags are already used in this column"
                >
                  <input
                    type="checkbox"
                    checked={cfg.includeDefaultReasonTags}
                    onChange={(e) => updateConfig({ includeDefaultReasonTags: e.target.checked })}
                  />
                  Include defaults
                </label>
              </span>
              {availableColumns.length > 0 ? (
                <select value={cfg.reasonColumn} onChange={(e) => updateConfig({ reasonColumn: e.target.value })}>
                  <option value="">-- none --</option>
                  {availableColumns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  placeholder="e.g. Reason"
                  value={cfg.reasonColumn}
                  onChange={(e) => updateConfig({ reasonColumn: e.target.value })}
                />
              )}
            </label>
            {/* Status is configurable for the same reason Reason is: it used
                to be a hardcoded name whose contents the app overwrote on
                load, wiping any pre-existing Status column a lab already
                used for something of their own. */}
            <ColumnPicker
              label="Status column"
              title="Column holding each case's annotation status. Existing values are kept and offered alongside the built-in ones."
              value={cfg.statusColumn}
              placeholder="e.g. Status"
              columns={availableColumns}
              onChange={(v) => updateConfig({ statusColumn: v })}
            />
            <ColumnPicker
              label="Annotation column"
              title="Where this app records the path of each saved annotation. Kept separate from the mask column so the original prediction's path is never lost."
              value={cfg.annotationColumn}
              placeholder="e.g. annotation_path"
              columns={availableColumns}
              onChange={(v) => updateConfig({ annotationColumn: v })}
            />
            <ColumnPicker
              label="Contrast column"
              title="Records whether a case is a contrast-enhanced scan, so the app knows before anyone starts annotating instead of relying on the Contrast checkbox being remembered."
              value={cfg.contrastColumn}
              placeholder="e.g. Contrast"
              columns={availableColumns}
              onChange={(v) => updateConfig({ contrastColumn: v })}
            />
          </div>

          {cfg.imageColumn && cfg.maskColumn && cfg.imageColumn === cfg.maskColumn && (
            <div className="busy-msg manifest-error">
              Image and Mask are set to the same column — every row will load its CT scan as its own mask.
            </div>
          )}

          <button
            className="advanced-toggle"
            onClick={() => updateConfig({ ...DEFAULT_MANIFEST_CONFIG, manifestPath: cfg.manifestPath })}
          >
            Reset column names to defaults
          </button>
        </>
      )}

      {pane.manifestError && <div className="busy-msg manifest-error">{pane.manifestError}</div>}

      {pane.manifestRows.length > 0 && (
        <label style={{ marginTop: 8 }}>
          Case ({pane.manifestRows.length} rows)
          <select value={pane.activeRowIndex ?? ''} onChange={(e) => handleSelectRow(e.target.value)}>
            <option value="">-- select --</option>
            {pane.manifestRows.map((r) => (
              <option key={r.index} value={r.index}>
                {r.patient_id || r.label}
                {!r.image_exists ? ' (image missing)' : !r.mask_path ? ' (no mask)' : !r.mask_exists ? ' (mask missing)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

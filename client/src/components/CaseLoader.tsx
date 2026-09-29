import type { ContrastSettings } from '../useContrastSettings'
import type { ManifestRow, PaneState } from '../types'
import { DEFAULT_MANIFEST_CONFIG } from '../types'
import type { ModeCaps } from '../modeConfig'
import { manifestDefaultsForCaps } from '../modeConfig'
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
  defaultValue,
  columns,
  onChange,
}: {
  label: string
  title: string
  value: string
  placeholder: string
  defaultValue: string
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
        <input
          type="text"
          className={value === defaultValue ? 'column-default' : ''}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  )
}

const MANIFEST_FILTERS = [
  { name: 'CSV / Excel', extensions: ['csv', 'xlsx', 'xls', 'xlsm'] },
  { name: 'All files', extensions: ['*'] },
]

// The part of the loaded scan's path that lies below what the user chose (e.g.
// the series sub-folder a DICOM folder search resolved to), or '' when the
// loaded scan IS what they chose.
function loadedSuffix(chosen: string, loaded: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const c = norm(chosen.trim())
  const l = norm(loaded)
  if (!c || !l || l.length <= c.length || l.slice(0, c.length).toLowerCase() !== c.toLowerCase()) return ''
  const rest = l.slice(c.length)
  if (!rest.startsWith('/')) return ''
  // Shown with the separator the user typed.
  return chosen.includes('\\') ? rest.replace(/\//g, '\\') : rest
}

// A path field that shows what the user chose in normal text and, after it in
// grey, where inside it the scan was actually found. The grey part is not part
// of the value: Load searches the chosen path again.
function PathField({
  value,
  suffix,
  placeholder,
  onChange,
}: {
  value: string
  suffix: string
  placeholder: string
  onChange: (next: string) => void
}) {
  return (
    <div className="path-field">
      <span className="path-field-input">
        <span className="path-field-sizer" aria-hidden>
          {value || placeholder}
        </span>
        <input type="text" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      </span>
      {suffix && (
        <span
          className="path-field-suffix"
          title="Loaded from inside the folder you chose. Load CT searches the whole folder again."
        >
          {suffix}
        </span>
      )}
    </div>
  )
}

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
  caps,
  contrastSettings,
  onContrastSettingsChange,
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
  caps: ModeCaps
  // Defaults for the contrast seed (Contrast screen only).
  contrastSettings?: ContrastSettings
  onContrastSettingsChange?: (next: ContrastSettings) => void
}) {
  const electronAvailable = isElectron()

  const cfg = pane.manifestConfig
  const availableColumns = pane.manifestColumns

  // A column-name field still holding the app's built-in default reads as grey
  // suggestion text; it turns normal once it has been edited.
  function untouchedDefault(key: 'imageColumn' | 'maskColumn' | 'patientIdColumn' | 'reasonColumn') {
    return cfg[key] === DEFAULT_MANIFEST_CONFIG[key] ? 'column-default' : ''
  }

  function updateConfig(partial: Partial<typeof cfg>) {
    onChange({ manifestConfig: { ...cfg, ...partial } })
  }

  async function handleBrowseCtFile() {
    const picked = await pickPath({ properties: ['openFile'], filters: IMAGE_FILE_FILTERS })
    if (picked) onChange({ ctInputPath: picked })
  }

  async function handleBrowseCtFolder() {
    const picked = await pickPath({ properties: ['openDirectory'] })
    if (picked) onChange({ ctInputPath: picked })
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

  // Returns the config it ended up with (also applied to the pane), so a caller
  // that goes on to load the manifest uses the reconciled column names rather
  // than the stale `cfg` from this render.
  async function tryDetectColumns(path: string, baseConfig: typeof cfg): Promise<typeof cfg> {
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
      const resolved: typeof cfg = {
          ...baseConfig,
          imageColumn: resolve(baseConfig.imageColumn, ['image', 'ct_path', 'img'], false),
          maskColumn: resolve(baseConfig.maskColumn, ['mask', 'seg'], true),
          patientIdColumn: resolve(baseConfig.patientIdColumn, ['patient'], true),
          // A column this screen doesn't show is never looked for, so it is
          // never read from or added to the file.
          reasonColumn: caps.columns.reason ? resolve(baseConfig.reasonColumn, ['reason'], true) : '',
          statusColumn: caps.columns.status ? resolve(baseConfig.statusColumn, ['status'], true) : '',
          // optional=false: keep the default name when the manifest has no
          // such column yet, so the backend creates it. Resolving to "none"
          // would leave saved annotations with nowhere to be recorded.
          annotationColumn: caps.columns.annotation ? resolve(baseConfig.annotationColumn, ['annotation'], false) : '',
          contrastColumn: caps.columns.contrast ? resolve(baseConfig.contrastColumn, ['contrast'], false) : '',
      }
      onChange({ manifestConfig: resolved })
      return resolved
    } catch {
      onChange({ manifestColumns: [], manifestConfig: baseConfig })
      return baseConfig
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
      // A path that was typed rather than picked has had no column detection
      // yet: without it the default "PatientId" is sent and the load fails on
      // any manifest that names it differently (or lacks it).
      const c = availableColumns.length === 0 ? await tryDetectColumns(cfg.manifestPath, cfg) : cfg
      const { rows, reasonOptions, statusOptions, scoreClasses, hasAnnotationColumn, hasContrastColumn } =
        await getManifestPairs({
          manifestPath: c.manifestPath,
          imageColumn: c.imageColumn,
          maskColumn: c.maskColumn,
          patientIdColumn: c.patientIdColumn,
          reasonColumn: c.reasonColumn,
          includeDefaultReasonTags: c.includeDefaultReasonTags,
          statusColumn: c.statusColumn,
          annotationColumn: c.annotationColumn,
          contrastColumn: c.contrastColumn,
          readOnly: caps.readOnlyManifest,
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
    await onLoadCt(pane.ctInputPath)
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
          <PathField
            placeholder="e.g. D:\\data\\CASE001\\CASE001_ST3.nii.gz"
            value={pane.ctInputPath}
            suffix={loadedSuffix(pane.ctInputPath, pane.ctPath)}
            onChange={(v) => onChange({ ctInputPath: v })}
          />
          <button onClick={handleBrowseCtFile} disabled={!electronAvailable} title={electronAvailable ? undefined : 'Only available in the desktop app'}>Browse file...</button>
          {(
            <button onClick={handleBrowseCtFolder} disabled={!electronAvailable} title={electronAvailable ? 'Pick a folder of DICOM slices' : 'Only available in the desktop app'}>
              Browse directory...
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
          <button onClick={handleBrowseMaskFile} disabled={!electronAvailable} title={electronAvailable ? undefined : 'Only available in the desktop app'}>Browse file...</button>
          <button onClick={handleLoadMaskSingle}>Load mask</button>
        </div>
      </label>
      {caps.edit && (
      <label>
        Save folder
        <div className="inline-row">
          <input
            type="text"
            placeholder="Asked for on your first save"
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
      )}
      {caps.contrast && contrastSettings && onContrastSettingsChange && (
        <div className="threshold-settings">
          <div className="threshold-settings-title">Contrast threshold</div>
          <div className="seg-toggle" role="group" aria-label="Threshold method">
            <button
              type="button"
              className={contrastSettings.method === 'aorta-sd' ? 'active' : ''}
              onClick={() => onContrastSettingsChange({ ...contrastSettings, method: 'aorta-sd' })}
            >
              From aorta seed
            </button>
            <button
              type="button"
              className={contrastSettings.method === 'fixed' ? 'active' : ''}
              onClick={() => onContrastSettingsChange({ ...contrastSettings, method: 'fixed' })}
            >
              Fixed HU
            </button>
          </div>
          {contrastSettings.method === 'aorta-sd' ? (
            <div className="threshold-body">
              <div className="threshold-left">
                <div className="threshold-params">
                  <label title="The seed samples a sphere of this volume inside the aorta">
                    Sphere
                    <input
                      type="number"
                      min={1}
                      value={contrastSettings.targetVolumeMm3}
                      onChange={(e) => onContrastSettingsChange({ ...contrastSettings, targetVolumeMm3: Number(e.target.value) })}
                    />
                    mm³
                  </label>
                  <label className="threshold-editable" title="How many standard deviations above the aortic mean">
                    k
                    <input
                      type="number"
                      step={0.1}
                      value={contrastSettings.kMultiplier}
                      onChange={(e) => onContrastSettingsChange({ ...contrastSettings, kMultiplier: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <div className="threshold-source">
                  <a href="https://eurointervention.pcronline.com/article/quantification-of-aortic-valve-calcification-on-contrast-enhanced-ct-of-patients-prior-to-transcatheter-aortic-valve-implantation" target="_blank" rel="noreferrer">
                    Eberhard 2017 · doi:10.4244/EIJ-D-17-00060
                  </a>{' '}
                  (k = 3)
                  <br />
                  <a href="https://doi.org/10.1016/j.jcct.2015.06.001" target="_blank" rel="noreferrer">
                    Schuhbaeck 2015 · doi:10.1016/j.jcct.2015.06.001
                  </a>{' '}
                  (k = 2)
                </div>
              </div>
              <div className="threshold-formula-big">
                <div className="threshold-formula-line">
                  threshold = aortic mean + <span className="formula-var">k</span> × SD
                </div>
                <div className="threshold-formula-note">
                  <span className="formula-var">k</span> is yours to change: currently {contrastSettings.kMultiplier}
                </div>
              </div>
            </div>
          ) : (
            <div className="threshold-body">
              <div className="threshold-left">
                <div className="threshold-params">
                  <label className="threshold-editable">
                    Value
                    <input
                      type="number"
                      min={1}
                      value={contrastSettings.fixedHu}
                      onChange={(e) => onContrastSettingsChange({ ...contrastSettings, fixedHu: Number(e.target.value) })}
                    />
                    HU
                  </label>
                </div>
                <div className="threshold-source">
                  <a href="https://doi.org/10.1016/j.jcct.2011.11.004" target="_blank" rel="noreferrer">
                    Otton 2012 · doi:10.1016/j.jcct.2011.11.004
                  </a>{' '}
                  (320 HU)
                </div>
              </div>
              <div className="threshold-formula-big">
                <div className="threshold-formula-line">
                  threshold = <span className="formula-var">{contrastSettings.fixedHu} HU</span>
                </div>
                <div className="threshold-formula-note">the same value for every scan, no seed</div>
              </div>
            </div>
          )}
        </div>
      )}

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
              <button onClick={handleBrowseManifest} disabled={!electronAvailable} title={electronAvailable ? undefined : 'Only available in the desktop app'}>Browse...</button>
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
                  className={untouchedDefault('imageColumn')}
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
                  className={untouchedDefault('maskColumn')}
                  value={cfg.maskColumn}
                  onChange={(e) => updateConfig({ maskColumn: e.target.value })}
                />
              )}
            </label>
            <label>
              ID column
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
                  className={untouchedDefault('patientIdColumn')}
                  placeholder="e.g. Index/ID"
                  value={cfg.patientIdColumn}
                  onChange={(e) => updateConfig({ patientIdColumn: e.target.value })}
                />
              )}
            </label>
            {caps.columns.reason && (
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
                  className={untouchedDefault('reasonColumn')}
                  placeholder="e.g. Reason"
                  value={cfg.reasonColumn}
                  onChange={(e) => updateConfig({ reasonColumn: e.target.value })}
                />
              )}
            </label>
            )}
            {/* Status is configurable for the same reason Reason is: it used
                to be a hardcoded name whose contents the app overwrote on
                load, wiping any pre-existing Status column a lab already
                used for something of their own. */}
            {caps.columns.status && (
            <ColumnPicker
              label="Status column"
              title="Column holding each case's annotation status. Existing values are kept and offered alongside the built-in ones."
              value={cfg.statusColumn}
              defaultValue={DEFAULT_MANIFEST_CONFIG.statusColumn}
              placeholder="e.g. Status"
              columns={availableColumns}
              onChange={(v) => updateConfig({ statusColumn: v })}
            />
            )}
            {caps.columns.annotation && (
            <ColumnPicker
              label="Annotation column"
              title="Where this app records the path of each saved annotation. Kept separate from the mask column so the original prediction's path is never lost."
              value={cfg.annotationColumn}
              defaultValue={DEFAULT_MANIFEST_CONFIG.annotationColumn}
              placeholder="e.g. annotation_path"
              columns={availableColumns}
              onChange={(v) => updateConfig({ annotationColumn: v })}
            />
            )}
            {caps.columns.contrast && (
            <ColumnPicker
              label="Contrast column"
              title="Records whether a case is a contrast-enhanced scan, so the app knows before anyone starts annotating instead of relying on the Contrast checkbox being remembered."
              value={cfg.contrastColumn}
              defaultValue={DEFAULT_MANIFEST_CONFIG.contrastColumn}
              placeholder="e.g. Contrast"
              columns={availableColumns}
              onChange={(v) => updateConfig({ contrastColumn: v })}
            />
            )}
          </div>

          {cfg.imageColumn && cfg.maskColumn && cfg.imageColumn === cfg.maskColumn && (
            <div className="busy-msg manifest-error">
              Image and Mask are set to the same column — every row will load its CT scan as its own mask.
            </div>
          )}

          <button
            className="advanced-toggle"
            onClick={() => updateConfig({ ...manifestDefaultsForCaps(caps), manifestPath: cfg.manifestPath })}
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

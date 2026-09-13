import type { ManifestRow, PaneState } from '../types'
import { DEFAULT_MANIFEST_CONFIG } from '../types'
import { getManifestColumns, getManifestPairs } from '../api'
import { IMAGE_FILE_FILTERS, isElectron, pickPath } from '../electronApi'

const MANIFEST_FILTERS = [
  { name: 'CSV / Excel', extensions: ['csv', 'xlsx', 'xls', 'xlsm'] },
  { name: 'All files', extensions: ['*'] },
]

export default function CaseLoader({
  pane,
  onChange,
  onLoadCt,
  onLoadMask,
}: {
  pane: PaneState
  onChange: (partial: Partial<PaneState>) => void
  onLoadCt: (path: string) => void
  onLoadMask: (path: string) => void
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

  async function handleBrowseMaskFolder() {
    const picked = await pickPath({ properties: ['openDirectory'] })
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
      const resolve = (current: string, keywords: string[]) => {
        if (cols.includes(current)) return current
        const ci = cols.find((c) => c.toLowerCase() === current.toLowerCase())
        if (ci) return ci
        const byKeyword = cols.find((c) => keywords.some((k) => c.toLowerCase().includes(k)))
        return byKeyword || current
      }
      onChange({
        manifestConfig: {
          ...baseConfig,
          imageColumn: resolve(baseConfig.imageColumn, ['image', 'ct_path', 'img']),
          maskColumn: resolve(baseConfig.maskColumn, ['mask', 'seg']),
          patientIdColumn: resolve(baseConfig.patientIdColumn, ['patient']),
        },
      })
    } catch {
      onChange({ manifestColumns: [], manifestConfig: baseConfig })
    }
  }

  function selectRow(row: ManifestRow) {
    onChange({ activeRowIndex: row.index })
    if (row.image_exists) {
      onLoadCt(row.image_path)
    } else {
      onChange({ manifestError: `Image not found: ${row.image_path}` })
    }
    if (row.mask_path) {
      if (row.mask_exists) {
        onLoadMask(row.mask_path)
      } else {
        onChange({ manifestError: `Mask not found: ${row.mask_path}` })
      }
    }
  }

  async function handleLoadManifest() {
    onChange({ manifestError: null, manifestRows: [], activeRowIndex: null })
    try {
      const rows = await getManifestPairs({
        manifestPath: cfg.manifestPath,
        imageColumn: cfg.imageColumn,
        maskColumn: cfg.maskColumn,
        patientIdColumn: cfg.patientIdColumn,
      })
      onChange({ manifestRows: rows })
      if (rows.length === 0) {
        onChange({ manifestError: 'Manifest loaded but no valid rows found (check the image column has paths).' })
      } else {
        selectRow(rows[0])
      }
    } catch (e) {
      onChange({ manifestError: e instanceof Error ? e.message : String(e) })
    }
  }

  function handleSelectRow(indexStr: string) {
    const idx = Number(indexStr)
    const row = pane.manifestRows.find((r) => r.index === idx)
    if (row) selectRow(row)
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
          <button onClick={() => onLoadCt(pane.ctPath)}>Load CT</button>
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
          {electronAvailable && (
            <button onClick={handleBrowseMaskFolder} title="Pick a folder of DICOM slices">
              Browse DICOM dir...
            </button>
          )}
          <button onClick={() => onLoadMask(pane.maskPath)}>Load mask</button>
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
          </div>

          <button
            className="add-label-btn"
            onClick={handleLoadManifest}
            disabled={!cfg.manifestPath || !cfg.patientIdColumn}
          >
            Load manifest
          </button>

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

import type { VolumeInfo } from '../types'

function fmt(v: number) {
  return Number.isFinite(v) ? v.toFixed(3) : String(v)
}

function Vec3({ label, v }: { label: string; v: number[] }) {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{v.map(fmt).join(', ')}</span>
    </div>
  )
}

export default function InfoPanel({ title, info }: { title: string; info: VolumeInfo | null }) {
  if (!info) {
    return (
      <div className="info-panel">
        <div className="info-title">{title}</div>
        <div className="info-empty">Not loaded</div>
      </div>
    )
  }
  const dir = info.direction
  return (
    <div className="info-panel">
      <div className="info-title">{title}</div>
      <div className="info-row">
        <span className="info-label">File</span>
        <span className="info-value info-path" title={info.path}>
          {info.path.split(/[\\/]/).slice(-2).join('/')}
        </span>
      </div>
      <div className="info-row">
        <span className="info-label">Dimensions</span>
        <span className="info-value">{info.size.join(' x ')}</span>
      </div>
      <Vec3 label="Spacing (mm)" v={info.spacing} />
      <Vec3 label="Origin" v={info.origin} />
      <div className="info-row">
        <span className="info-label">Direction</span>
        <span className="info-value info-matrix">
          {[0, 1, 2].map((r) => (
            <div key={r}>{dir.slice(r * 3, r * 3 + 3).map(fmt).join('  ')}</div>
          ))}
        </span>
      </div>
      <div className="info-row">
        <span className="info-label">Data type</span>
        <span className="info-value">{info.dtype}</span>
      </div>
      <div className="info-row">
        <span className="info-label">Value range</span>
        <span className="info-value">
          {fmt(info.value_min)} to {fmt(info.value_max)}
        </span>
      </div>
      {info.labels && (
        <div className="info-row">
          <span className="info-label">Labels present</span>
          <span className="info-value">{info.labels.join(', ')}</span>
        </div>
      )}
    </div>
  )
}

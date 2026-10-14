import { useState } from "react";
import type { EquipmentConfig, NativeFrame, ParamMapping } from "../../../shared/types";
import { S } from "../../strings";
import { usePoll, type VendorInfo } from "../../store";
import { fmtTime } from "../../format";
import { Empty, Seg, VendorTag } from "../../components/ui";

export function NativePanel({ cfg, mappings, vendor }: { cfg: EquipmentConfig; mappings: ParamMapping[]; vendor: VendorInfo }) {
  const [kind, setKind] = useState("");
  const { data: frames } = usePoll<NativeFrame[]>(`/api/equipment/${encodeURIComponent(cfg.id)}/frames?limit=120${kind ? `&kind=${kind}` : ""}`, 2000);
  const [sel, setSel] = useState<number | null>(null);
  const frame = frames?.find((f) => f.seq === sel) ?? frames?.[0];
  const [chamber, setChamber] = useState(cfg.chambers[0]);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="note">
        <VendorTag vendor={vendor.id} /> <b>{vendor.name}</b> · {vendor.protocol} — {vendor.description}
        <br />
        {S.native.hint}
      </div>
      <div className="split">
        <div className="card">
          <div className="card-head">
            <h3>{S.native.frames}</h3>
            <Seg
              options={[
                ["", S.common.all],
                ["trace", "trace"],
                ["event", "event"],
                ["alarm", "alarm"],
                ["command", "command"],
              ]}
              value={kind}
              onChange={setKind}
            />
          </div>
          {!frames?.length ? (
            <Empty />
          ) : (
            <div className="table-wrap tall">
              <table className="t">
                <thead>
                  <tr>
                    <th>{S.common.time}</th>
                    <th>{S.native.direction}</th>
                    <th>{S.native.kind}</th>
                    <th>{S.common.message}</th>
                  </tr>
                </thead>
                <tbody>
                  {frames.map((f) => (
                    <tr key={f.seq} className={`click ${frame?.seq === f.seq ? "sel" : ""}`} onClick={() => setSel(f.seq)}>
                      <td className="num">{fmtTime(f.ts)}</td>
                      <td>{f.direction}</td>
                      <td>{f.kind}</td>
                      <td className="mono">{f.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h3>{frame ? frame.summary : S.native.frames}</h3>
          {frame && <pre className="frame-text">{frame.text}</pre>}
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3>{S.native.mapping}</h3>
          <Seg options={cfg.chambers.map((c) => [c, c] as [string, string])} value={chamber} onChange={setChamber} />
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>{S.native.svid}</th>
                <th>{S.native.nativeName}</th>
                <th>{S.native.nativeUnit}</th>
                <th>→</th>
                <th>{S.native.canonical}</th>
                <th>{S.common.parameter}</th>
                <th>{S.native.canonicalUnit}</th>
              </tr>
            </thead>
            <tbody>
              {mappings
                .filter((m) => m.chamberId === chamber)
                .map((m) => (
                  <tr key={m.svid}>
                    <td className="num">{m.svid}</td>
                    <td className="mono">{m.nativeName}</td>
                    <td>{m.nativeUnit}</td>
                    <td className="muted">→</td>
                    <td className="mono">{m.key}</td>
                    <td>{m.name}</td>
                    <td>{m.canonicalUnit}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

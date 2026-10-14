import { useEffect, useState } from "react";
import type { EquipmentConfig, Recipe } from "../../../shared/types";
import { S } from "../../strings";
import { toasts } from "../../store";

export function RecipePanel({ cfg, onSave }: { cfg: EquipmentConfig; onSave: (c: EquipmentConfig) => Promise<boolean> }) {
  const [recipes, setRecipes] = useState<Recipe[]>(() => structuredClone(cfg.recipes));
  const [selId, setSelId] = useState<string | undefined>(cfg.recipes[0]?.id);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setRecipes(structuredClone(cfg.recipes));
    setDirty(false);
  }, [cfg]);
  const recipe = recipes.find((r) => r.id === selId) ?? recipes[0];

  const update = (fn: (r: Recipe) => void) => {
    setRecipes((rs) =>
      rs.map((r) => {
        if (r.id !== recipe.id) return r;
        const copy = structuredClone(r);
        fn(copy);
        return copy;
      }),
    );
    setDirty(true);
  };

  const [newId, setNewId] = useState<string | null>(null);
  const addRecipe = () => {
    const id = (newId ?? "").trim();
    if (!id) return;
    if (recipes.some((r) => r.id === id)) {
      toasts.push(`${id} exists`, "error");
      return;
    }
    const copy: Recipe = recipe ? { ...structuredClone(recipe), id, name: `${recipe.name} (copy)` } : { id, name: id, steps: [{ name: "Step 1", duration: 10, setpoints: {} }] };
    setRecipes((rs) => [...rs, copy]);
    setSelId(id);
    setNewId(null);
    setDirty(true);
  };

  const removeRecipe = () => {
    if (recipes.length <= 1 || !window.confirm(S.common.confirmDelete)) return;
    setRecipes((rs) => rs.filter((r) => r.id !== recipe.id));
    setSelId(recipes.find((r) => r.id !== recipe.id)?.id);
    setDirty(true);
  };

  const save = async () => {
    const defaultRecipeId = recipes.some((r) => r.id === cfg.generation.defaultRecipeId) ? cfg.generation.defaultRecipeId : recipes[0].id;
    const ok = await onSave({ ...cfg, recipes, generation: { ...cfg.generation, defaultRecipeId } });
    if (ok) setDirty(false);
  };

  if (!recipe) return null;
  const total = recipe.steps.reduce((s, x) => s + x.duration, 0);

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row">
        <select value={recipe.id} onChange={(e) => setSelId(e.target.value)} aria-label={S.common.recipe}>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} — {r.name}
            </option>
          ))}
        </select>
        <input value={recipe.name} onChange={(e) => update((r) => (r.name = e.target.value))} aria-label={S.recipe.name} style={{ width: 220 }} />
        <span className="muted">
          {S.recipe.total}: {total}s · {S.recipe.defaultRecipe}: {cfg.generation.defaultRecipeId}
        </span>
        <span style={{ flex: 1 }} />
        {newId === null ? (
          <button className="btn" onClick={() => setNewId(`${recipe.id}_COPY`)}>
            + {S.recipe.addRecipe}
          </button>
        ) : (
          <>
            <input
              autoFocus
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRecipe()}
              aria-label={S.recipe.newRecipeId}
              placeholder={S.recipe.newRecipeId}
              style={{ width: 180 }}
            />
            <button className="btn" onClick={addRecipe} disabled={!newId.trim()}>
              {S.common.add}
            </button>
            <button className="btn ghost" onClick={() => setNewId(null)}>
              {S.common.cancel}
            </button>
          </>
        )}
        <button className="btn danger" onClick={removeRecipe} disabled={recipes.length <= 1}>
          {S.common.delete}
        </button>
        <button className="btn primary" onClick={save} disabled={!dirty}>
          {S.common.save}
        </button>
      </div>
      {dirty && <div className="note">{S.recipe.unsaved}</div>}
      <div className="table-wrap tall">
        <table className="t">
          <thead>
            <tr>
              <th>#</th>
              <th>{S.recipe.name}</th>
              <th className="num">{S.recipe.duration}</th>
              {cfg.parameters.map((p) => (
                <th key={p.key} className="num" title={p.key}>
                  {p.name}
                  <br />
                  <span className="muted">
                    {p.unit} · idle {p.idle}
                  </span>
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {recipe.steps.map((st, i) => (
              <tr key={i}>
                <td className="num">{i + 1}</td>
                <td>
                  <input value={st.name} onChange={(e) => update((r) => (r.steps[i].name = e.target.value))} style={{ width: 130 }} />
                </td>
                <td className="num">
                  <input type="number" min={1} value={st.duration} onChange={(e) => update((r) => (r.steps[i].duration = Number(e.target.value)))} />
                </td>
                {cfg.parameters.map((p) => (
                  <td key={p.key} className="num">
                    <input
                      type="number"
                      value={st.setpoints[p.key] ?? ""}
                      placeholder={String(p.idle)}
                      onChange={(e) =>
                        update((r) => {
                          if (e.target.value === "") delete r.steps[i].setpoints[p.key];
                          else r.steps[i].setpoints[p.key] = Number(e.target.value);
                        })
                      }
                    />
                  </td>
                ))}
                <td>
                  <button className="btn small ghost" onClick={() => update((r) => r.steps.splice(i, 1))} disabled={recipe.steps.length <= 1} title={S.recipe.removeStep}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="btn" onClick={() => update((r) => r.steps.push({ name: `Step ${r.steps.length + 1}`, duration: 10, setpoints: {} }))}>
          + {S.recipe.addStep}
        </button>
        <span className="muted">{S.recipe.hint}</span>
      </div>
    </div>
  );
}

// Identidade e trazos dun territorio: lóxica pura (sen DOM).
// Cada trazo vive no seu territorio; comarcas, provincias e Galiza herdan os dos
// territorios que conteñen e agrúpanse por categoría.
import { getDescendantIds } from "./territory_data.js";
import { normalizeText } from "./utils.js";

export const TRAIT_LIMITS = { trait: 120, category: 40, notes: 600 };

// Categorías suxeridas (a persoa pode escribir outra). A orde é a de amosado.
export const TRAIT_CATEGORIES = [
  "Música e instrumentos",
  "Baile",
  "Fala e lingua",
  "Festas e tradicións",
  "Oficios e vida tradicional",
  "Historia e memoria",
  "Xente e cantores",
];
export const NO_CATEGORY_LABEL = "Sen clasificar";

function categoryKey(category) {
  return normalizeText(category || "") || "";
}

// Devolve [{ key, label, items }] coas categorías suxeridas primeiro, despois as
// outras por orde alfabética e ao final «Sen clasificar». `entries` ten forma
// { trait, source } e cada item pode ter varias orixes.
function classify(entries) {
  const buckets = new Map();
  const labelByKey = new Map();
  TRAIT_CATEGORIES.forEach(label => labelByKey.set(categoryKey(label), label));
  entries.forEach(entry => {
    const key = categoryKey(entry.trait.category);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label: labelByKey.get(key) || (key ? String(entry.trait.category).trim() : NO_CATEGORY_LABEL), items: new Map() });
    }
    const bucket = buckets.get(key);
    const itemKey = normalizeText(entry.trait.trait);
    if (!bucket.items.has(itemKey)) bucket.items.set(itemKey, { key: itemKey, trait: entry.trait.trait, sources: [] });
    const item = bucket.items.get(itemKey);
    if (!item.sources.some(source => source.id === entry.source.id)) {
      item.sources.push({ id: entry.source.id, nome: entry.source.nome, tipo: entry.source.tipo, traitId: entry.trait.id, notes: entry.trait.notes || "" });
    }
  });
  const order = new Map(TRAIT_CATEGORIES.map((label, index) => [categoryKey(label), index]));
  return Array.from(buckets.values())
    .map(bucket => ({
      key: bucket.key,
      label: bucket.label,
      items: Array.from(bucket.items.values())
        .map(item => ({ ...item, sources: item.sources.sort((a, b) => a.nome.localeCompare(b.nome, "gl")) }))
        .sort((a, b) => b.sources.length - a.sources.length || a.trait.localeCompare(b.trait, "gl")),
    }))
    .sort((a, b) => {
      const rank = bucket => (bucket.key === "" ? 2 : order.has(bucket.key) ? 0 : 1);
      return rank(a) - rank(b) || (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0) || a.label.localeCompare(b.label, "gl");
    });
}

// Trazos propios do territorio, por categoría (cada item ten un único «source»: o propio territorio).
export function classifyOwnTraits(territory) {
  if (!territory) return [];
  return classify((territory.traits || []).map(trait => ({ trait, source: territory })));
}

// Trazos dos territorios de dentro (comarcas↔concellos son moitos a moitos, así que
// se usan os descendentes de verdade e non a cadea de pais). Para Galiza (territory
// = null) entran todos os territorios.
export function classifyInheritedTraits(territory, all) {
  const scope = territory
    ? new Set(getDescendantIds(territory, all).filter(id => id !== territory.id))
    : null;
  const entries = [];
  all.forEach(item => {
    if (scope ? !scope.has(item.id) : false) return;
    (item.traits || []).forEach(trait => entries.push({ trait, source: item }));
  });
  return classify(entries);
}

export function countTraitItems(groups) {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

// Categorías xa usadas en calquera territorio (para completar o selector).
export function knownTraitCategories(all) {
  const seen = new Map();
  TRAIT_CATEGORIES.forEach(label => seen.set(categoryKey(label), label));
  all.forEach(item => (item.traits || []).forEach(trait => {
    const key = categoryKey(trait.category);
    if (key && !seen.has(key)) seen.set(key, String(trait.category).trim());
  }));
  return Array.from(seen.values());
}

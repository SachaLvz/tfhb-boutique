// @ts-nocheck — logique legacy migrée ; typage progressif
// Catalogue TFHB — extrait fidèlement des fichiers Excel
// « Caisse Boutique TFHB 25-26 / 26-27 ». Prix taille-dépendants.
// Sert à l'import initial (aucune ressaisie à la main).

export const SIZE_SYSTEMS = {
  maillot_enfant: ['5-6 ans', '7/8', '9/10', '11/12', '13/14', '15/16'],
  textile_enfant: ['4-6 ans', '6/8', '8/10', '10/12', '12/14'],
  adulte: ['S', 'M', 'L', 'XL', '2XL'],
  tu: ['TU'],
};

// Fabrique des variantes taille→prix. cp = prix enfant, ap = prix adulte.
function childAdult(childSystem, cp, ap, { achat = null, marquage = 0 } = {}) {
  const out = [];
  if (childSystem) {
    for (const s of SIZE_SYSTEMS[childSystem])
      out.push({ size: s, size_system: childSystem, sale_price: cp, purchase_price_ht: achat, marking_cost: marquage });
  }
  for (const s of SIZE_SYSTEMS.adulte)
    out.push({ size: s, size_system: 'adulte', sale_price: ap, purchase_price_ht: achat, marking_cost: marquage });
  return out;
}
function childOnly(childSystem, price, opts = {}) {
  return SIZE_SYSTEMS[childSystem].map((s) => ({
    size: s, size_system: childSystem, sale_price: price,
    purchase_price_ht: opts.achat ?? null, marking_cost: opts.marquage ?? 0,
  }));
}
function adultOnly(price, opts = {}) {
  return SIZE_SYSTEMS.adulte.map((s) => ({
    size: s, size_system: 'adulte', sale_price: price,
    purchase_price_ht: opts.achat ?? null, marking_cost: opts.marquage ?? 0,
  }));
}
function tu(price, opts = {}) {
  return [{ size: 'TU', size_system: 'tu', sale_price: price, purchase_price_ht: opts.achat ?? null, marking_cost: opts.marquage ?? 0 }];
}

// id stable = slug, sert de préfixe SKU (id|taille)
export const SEED_CATALOG = [
  // --- Maillots ---
  { id: 'maillot_bleu', name: 'Maillot Bleu (Domicile)', category: 'Maillot', variants: childAdult('maillot_enfant', 60, 70) },
  { id: 'maillot_blanc', name: 'Maillot Blanc (Extérieur)', category: 'Maillot', variants: childAdult('maillot_enfant', 60, 70) },
  { id: 'maillot_rose', name: 'Maillot Rose', category: 'Maillot', variants: childAdult('maillot_enfant', 50, 60) },

  // --- Fin de saison 25/26 (déstockage) ---
  { id: 'maillot_domicile_2526', name: 'Maillot Domicile 25/26', category: '25/26', variants: childOnly('maillot_enfant', 40) },
  { id: 'maillot_exterieur_2526', name: 'Maillot Extérieur 25/26', category: '25/26', variants: childOnly('maillot_enfant', 40) },
  { id: 'warmup', name: 'Maillot WarmUp 25/26', category: '25/26', variants: childOnly('maillot_enfant', 40) },
  { id: 'gardien_vert', name: 'Maillot Gardien Vert 25/26', category: '25/26', variants: adultOnly(75) },

  // --- Textiles ---
  { id: 'entrainement', name: 'Entraînement', category: 'Textile', variants: adultOnly(22) },
  { id: 'tshirt_blanc', name: 'T-shirt Blanc', category: 'Textile', variants: childAdult('textile_enfant', 15, 25) },
  { id: 'tshirt_bleu', name: 'T-shirt Bleu', category: 'Textile', variants: childAdult('textile_enfant', 15, 15) },
  { id: 'tshirt_noir', name: 'T-shirt Noir', category: 'Textile', variants: childAdult('textile_enfant', 20, 25) },
  { id: 'pull_bleu', name: 'Pull Bleu', category: 'Textile', variants: childAdult('textile_enfant', 40, 45) },
  { id: 'pull_noir', name: 'Pull Noir', category: 'Textile', variants: childAdult('textile_enfant', 40, 45) },

  // --- Accessoires (TU) ---
  { id: 'echarpe', name: 'Écharpe', category: 'Accessoire', variants: tu(10) },
  { id: 'tote_bag', name: 'Tote bag', category: 'Accessoire', variants: tu(10) },
  { id: 'stylo', name: 'Stylo', category: 'Accessoire', variants: tu(2) },
  { id: 'pins', name: 'Pins', category: 'Accessoire', variants: tu(2) },
  { id: 'porte_cles', name: 'Porte-clés', category: 'Accessoire', variants: tu(3) },
  { id: 'decapsuleur', name: 'Décapsuleur', category: 'Accessoire', variants: tu(3) },
  { id: 'poster', name: 'Poster', category: 'Accessoire', variants: tu(1) },

  // --- Ballons (rangés dans Accessoires) ---
  { id: 'ballon_promo', name: 'Ballon Promo', category: 'Accessoire', variants: tu(15) },
  { id: 'ballon_t3', name: 'Ballon T3', category: 'Accessoire', variants: tu(30) },
];

export const CATEGORIES = ['Maillot', 'Textile', 'Accessoire', '25/26'];
// libellés d'onglets (sans « s » automatique pour « 25/26 »)
export const CATEGORY_LABELS = { Maillot: 'Maillots', Textile: 'Textiles', Accessoire: 'Accessoires', '25/26': '25/26' };

// Matchs 26-27 (feuilles du fichier « en préparation »)
export const SEED_MATCHES = [
  { code: 'J01', label: 'Nantes' }, { code: 'J03', label: 'St-Raphaël' },
  { code: 'J05', label: 'Sélestat' }, { code: 'J06', label: 'Montpellier' },
  { code: 'J08', label: 'Cesson' }, { code: 'J10', label: 'Caen' },
  { code: 'J12', label: 'Toulouse' }, { code: 'J15', label: 'Aix' },
  { code: 'J17', label: 'Nîmes' }, { code: 'J19', label: 'Chartres' },
  { code: 'J21', label: 'Paris' }, { code: 'J24', label: 'Saran' },
  { code: 'J26', label: 'Chambéry' }, { code: 'J28', label: 'Limoges' },
  { code: 'J30', label: 'Dunkerque' },
];

export const sku = (productId, size) => `${productId}|${size}`;

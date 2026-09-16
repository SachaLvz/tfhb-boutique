// @ts-nocheck — logique legacy migrée ; typage progressif
// Catalogue TFHB — boutique officielle WePlay
// https://boutique.osports.fr/tremblay-handball/ (scrapé le 16/09/2026).

export const SIZE_SYSTEMS = {
  maillot_enfant: ['5/6 ans', '7/8 ans', '9/10 ans', '11/12 ans', '13/14 ans', '15/16 ans'],
  textile_enfant: ['4/6 ans', '6/8 ans', '8/10 ans', '10/12 ans', '12/14 ans'],
  adidas_junior: ['116', '128', '140', '152', '164', '176'],
  adulte: ['S', 'M', 'L', 'XL', 'XXL', '2XL'],
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

function priced(sizes, system, price, ht) {
  return sizes.map((s) => ({
    size: s, size_system: system, sale_price: price,
    purchase_price_ht: ht, marking_cost: 0,
  }));
}

// Catalogue officiel WePlay / [boutique.osports.fr](https://boutique.osports.fr/tremblay-handball/)
// (scrapé le 16/09/2026). Tailles = celles réellement proposées en ligne.
export const SEED_CATALOG = [
  // --- Maillot ---
  { id: 'maillot_domicile_bleu_adulte_2627', name: 'Maillot Domicile Bleu Adulte 26/27', category: 'Maillot',
    variants: priced(['S', 'M', 'XL', 'XXL'], 'adulte', 75, 62.5) },
  { id: 'maillot_domicile_bleu_enfant_2627', name: 'Maillot Domicile Bleu Enfant 26/27', category: 'Maillot',
    variants: priced(['5/6 ans', '7/8 ans', '9/10 ans', '11/12 ans', '13/14 ans', '15/16 ans'], 'maillot_enfant', 65, 54.17) },
  { id: 'maillot_exterieur_adulte_adidas', name: 'Maillot Extérieur Adulte Blanc 26/27', category: 'Maillot',
    variants: priced(['S', 'M', 'L', 'XL', 'XXL'], 'adulte', 75, 62.5) },
  { id: 'maillot_exterieur_blanc_enfant_2627', name: 'Maillot Extérieur Blanc Enfant 26/27', category: 'Maillot',
    variants: priced(['5/6 ans', '7/8 ans', '9/10 ans', '11/12 ans', '13/14 ans', '15/16 ans'], 'maillot_enfant', 65, 54.17) },
  { id: 'maillot_pre_match_adidas_adulte_2627', name: 'Maillot Pré-Match Adidas Adulte 26/27', category: 'Maillot',
    variants: priced(['XXL'], 'adulte', 65, 54.17) },
  { id: 'maillot_pre_match_enfant_2627', name: 'Maillot Pré-Match Enfant 26/27', category: 'Maillot',
    variants: priced(['9/10 ans', '11/12 ans', '13/14 ans'], 'maillot_enfant', 55, 45.83) },
  { id: 'maillot_domicile_junior_adidas', name: 'Maillot Domicile Junior Adidas', category: 'Maillot',
    variants: priced(['116', '128', '140', '152', '164', '176'], 'adidas_junior', 60, 50) },
  { id: 'maillot_exterieur_junior_adidas', name: 'Maillot Extérieur Junior Adidas', category: 'Maillot',
    variants: priced(['116', '128', '140', '152', '164'], 'adidas_junior', 60, 50) },
  { id: 'maillot_warm_up_adidas_junior', name: 'Maillot Warm up Adidas Junior', category: 'Maillot',
    variants: priced(['116', '128', '140'], 'adidas_junior', 50, 41.67) },
  // --- Floqué ---
  { id: 'maillot_floque_domicile_bleu_adulte_2627', name: 'Maillot Floqué Domicile Bleu Adulte 26/27', category: 'Floqué',
    variants: priced(['S', 'M', 'L', 'XL', 'XXL'], 'adulte', 83, 69.17) },
  { id: 'maillot_floque_domicile_bleu_enfant_2627', name: 'Maillot Floqué Domicile Bleu Enfant 26/27', category: 'Floqué',
    variants: priced(['5/6 ans', '7/8 ans', '9/10 ans', '11/12 ans', '13/14 ans', '15/16 ans'], 'maillot_enfant', 73, 60.83) },
  { id: 'maillot_floque_exterieur_adulte_blanc_2627', name: 'Maillot Floqué Extérieur Adulte Blanc 26/27', category: 'Floqué',
    variants: priced(['M', 'L', 'XL', 'XXL'], 'adulte', 83, 69.17) },
  { id: 'maillot_floque_exterieur_blanc_enfant_2627', name: 'Maillot Floqué Extérieur Blanc Enfant 26/27', category: 'Floqué',
    variants: priced(['5/6 ans', '7/8 ans', '9/10 ans', '11/12 ans', '13/14 ans', '15/16 ans'], 'maillot_enfant', 73, 60.83) },
  { id: 'maillot_floque_pre_match_adidas_adulte_2627', name: 'Maillot Floqué Pré-Match Adidas Adulte 26/27', category: 'Floqué',
    variants: priced(['XXL'], 'adulte', 73, 60.83) },
  { id: 'maillot_floque_pre_match_enfant_2627', name: 'Maillot Floqué Pré-Match Enfant 26/27', category: 'Floqué',
    variants: priced(['5/6 ans', '7/8 ans', '9/10 ans', '11/12 ans', '13/14 ans'], 'maillot_enfant', 63, 52.5) },
  // --- Textile ---
  { id: 't_shirt_adulte_navy', name: 'T-shirt Adulte Navy', category: 'Textile',
    variants: priced(['S', 'M', 'L', 'XL'], 'adulte', 15, 12.5) },
  { id: 't_shirt_junior_navy', name: 'T-shirt Junior Navy', category: 'Textile',
    variants: priced(['4/6 ans', '6/8 ans', '8/10 ans', '10/12 ans', '12/14 ans'], 'textile_enfant', 15, 12.5) },
  { id: 't_shirt_tremblay_adulte_gris_et_blanc_adidas', name: 'T-shirt TREMBLAY Adulte Gris et Blanc Adidas', category: 'Textile',
    variants: priced(['S', 'L', 'XL'], 'adulte', 25, 20.83) },
  { id: 'hoody_navy_adulte', name: 'Hoody Navy Adulte', category: 'Textile',
    variants: priced(['S', 'M', 'L', 'XL'], 'adulte', 45, 37.5) },
  { id: 'hoody_navy_junior', name: 'Hoody Navy Junior', category: 'Textile',
    variants: priced(['4/6 ans', '6/8 ans', '8/10 ans', '10/12 ans', '12/14 ans'], 'textile_enfant', 40, 33.33) },
  { id: 'hoody_adulte_noir_adidas', name: 'Hoody Adulte Noir Adidas', category: 'Textile',
    variants: priced(['S', 'M', 'L', 'XL'], 'adulte', 45, 37.5) },
];

export const CATEGORIES = ['Maillot', 'Floqué', 'Textile'];
export const CATEGORY_LABELS = { Maillot: 'Maillots', Floqué: 'Floqués', Textile: 'Textiles' };

// Matchs à domicile 26-27 — Daikin StarLigue, calendrier LNH (scrapé le 16/09/2026).
// Horaires encore « provisoires » à partir de J10.
export const SEED_MATCHES = [
  { code: 'J01', label: 'Nantes', date: '2026-09-05', logo: '/assets/clubs/nantes.png' },
  { code: 'J03', label: 'Saint-Raphaël', date: '2026-09-18', logo: '/assets/clubs/saint-raphael.png' },
  { code: 'J05', label: 'Sélestat', date: '2026-10-02', logo: '/assets/clubs/selestat.png' },
  { code: 'J06', label: 'Montpellier', date: '2026-10-11', logo: '/assets/clubs/montpellier.png' },
  { code: 'J08', label: 'Cesson-Rennes', date: '2026-10-23', logo: '/assets/clubs/cesson-rennes.png' },
  { code: 'J10', label: 'Caen', date: '2026-11-13', logo: '/assets/clubs/caen.png' },
  { code: 'J12', label: 'Toulouse', date: '2026-11-27', logo: '/assets/clubs/toulouse.png' },
  { code: 'J15', label: 'Aix', date: '2026-12-22', logo: '/assets/clubs/aix.png' },
  { code: 'J17', label: 'Nîmes', date: '2027-02-12', logo: '/assets/clubs/nimes.png' },
  { code: 'J19', label: 'Chartres', date: '2027-02-26', logo: '/assets/clubs/chartres.png' },
  { code: 'J21', label: 'Paris', date: '2027-03-19', logo: '/assets/clubs/paris.png' },
  { code: 'J24', label: 'Saran', date: '2027-04-09', logo: '/assets/clubs/saran.png' },
  { code: 'J26', label: 'Chambéry', date: '2027-04-16', logo: '/assets/clubs/chambery.png' },
  { code: 'J28', label: 'Limoges', date: '2027-04-30', logo: '/assets/clubs/limoges.png' },
  { code: 'J30', label: 'Dunkerque', date: '2027-05-19', logo: '/assets/clubs/dunkerque.png' },
];

export function formatMatchDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}

export const sku = (productId, size) => `${productId}|${size}`;

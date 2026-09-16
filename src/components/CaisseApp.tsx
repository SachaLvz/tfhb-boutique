"use client";

import { useEffect } from "react";

/**
 * Coquille DOM de l'app (legacy) + boot client-side.
 * IndexedDB, overlays et vues restent pilotés par src/lib/*.ts.
 *
 * Pas de garde « booted une seule fois » : Fast Refresh remonte ce composant
 * et recrée le shell DOM — boot() doit pouvoir ré-afficher la vue courante.
 */
export default function CaisseApp() {
  useEffect(() => {
    let cancelled = false;
    void import("@/lib/app").then(({ boot }) => {
      if (!cancelled) void boot();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/icons/logo-white.png"
              alt="TFHB"
              onLoad={(e) => e.currentTarget.parentElement?.classList.add("has-img")}
              onError={(e) => e.currentTarget.remove()}
            />
            T
          </span>
          <span className="wm">
            Boutique <b>TFHB</b>
          </span>
        </div>
        <nav className="tabs-main" id="navMain" />
        <div className="sep" />
        <button className="match" id="matchBtn" type="button">
          <small>Match</small> <b id="matchName">—</b> ▾
        </button>
        <div className="chip" id="netChip">
          <span className="dot" />
          <span id="netTxt">Hors-ligne</span>
        </div>
      </header>

      <main id="view">
        <div className="page-loader" role="status" aria-live="polite">
          <div className="page-loader-spin" aria-hidden />
          <p>Chargement de l&apos;application…</p>
        </div>
      </main>

      <div className="ov" id="ov">
        <div className="sheet">
          <h3>
            <span id="ovName">Article</span>
            <button className="x" id="ovClose" type="button">
              ×
            </button>
          </h3>
          <div className="sizes" id="ovSizes" />
        </div>
      </div>

      <div className="ov" id="payOv">
        <div className="sheet">
          <h3>
            Encaissement
            <button className="x" id="payClose" type="button">
              ×
            </button>
          </h3>
          <div className="pay-body">
            <div className="pay-total" id="payTotal">
              0 €
            </div>
            <p className="pay-sub">Moyen de paiement</p>
            <div className="pay-methods" id="payMethods" />
            <label className="receipt">
              <input type="checkbox" id="wantReceipt" /> Générer un reçu (PDF)
            </label>
            <button className="encais" id="payConfirm" type="button">
              Valider la vente
            </button>
          </div>
        </div>
      </div>

      <div className="ov" id="matchOv">
        <div className="sheet">
          <h3>
            Choisir le match
            <button className="x" id="matchClose" type="button">
              ×
            </button>
          </h3>
          <div className="match-list" id="matchList" />
        </div>
      </div>

      <div className="toast" id="toast" />
      <div id="modalHost" />
    </>
  );
}

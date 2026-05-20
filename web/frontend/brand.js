export const promoMintColors = {
  indigo: "#5f4638",
  indigoDark: "#3c2a21",
  mint: "#d8c2a8",
  mintSoft: "#f6efe7",
  indigoSoft: "#ede2d3",
  text: "#111111",
  mutedText: "#5b4637",
  border: "#d6c2b0",
  borderStrong: "#a8856a",
  shadow: "rgba(60, 42, 33, 0.12)",
  shadowStrong: "rgba(95, 70, 56, 0.22)",
};

export const promoMintStyles = {
  appFrame: {
    minHeight: "100vh",
    background: `linear-gradient(180deg, ${promoMintColors.indigoSoft} 0%, ${promoMintColors.mintSoft} 26%, #fffaf5 100%)`,
    color: promoMintColors.text,
  },
  heroCard: {
    borderRadius: 18,
    border: `1px solid ${promoMintColors.border}`,
    boxShadow: `0 12px 30px ${promoMintColors.shadow}`,
    background: `linear-gradient(135deg, #fffaf5 0%, ${promoMintColors.mintSoft} 100%)`,
  },
  accentCard: {
    borderRadius: 18,
    border: `1px solid ${promoMintColors.border}`,
    boxShadow: `0 10px 26px ${promoMintColors.shadow}`,
    background: "#fffaf5",
  },
  primaryButton: {
    background: `linear-gradient(135deg, ${promoMintColors.indigo} 0%, ${promoMintColors.indigoDark} 100%)`,
    color: "#ffffff",
    border: "none",
    fontWeight: 600,
  },
  secondaryButton: {
    background: "#efe2d3",
    color: promoMintColors.text,
    border: `1px solid ${promoMintColors.borderStrong}`,
    fontWeight: 600,
  },
};

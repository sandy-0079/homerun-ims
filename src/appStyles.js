// Shared page palette + style objects, moved verbatim out of App.jsx so extracted
// tabs (src/tabs/ToolOutputTab.jsx) render with the exact same values.

export const HR = {
  yellow:"#F5C400",yellowDark:"#D4A800",black:"#1A1A1A",white:"#FFFFFF",
  bg:"#F5F5F0",surface:"#FFFFFF",surfaceLight:"#F0F0E8",border:"#E0E0D0",
  muted:"#888870",text:"#1A1A1A",textSoft:"#444438",green:"#2D7A3A",
};
// ⚠⚠ `yellow` AND `yellowDark` ARE FILLS, NOT TEXT COLOURS. Measured on white
// 2026-09-18: 1.64:1 and 2.23:1 — both fail WCAG AA at every size. They are correct
// behind black text on a button, and unreadable as text on the page. `yellowDark`
// had drifted into use for the SKU Detail header's 17px figures, i.e. LOWER contrast
// than the 10px labels beneath them; those now use `green` (5.31:1). The name is the
// trap — "yellowDark" sounds like the safe one. For dark text use `text` (17.4:1),
// `textSoft` (9.9:1) or `green` (5.31:1).
// ⚠ Still used as text elsewhere (Overview KPIs, Logic Tweaker figures, the boxed
// StatStrip default). Not swept 2026-09-18 — a palette pass across the app is its own
// change. Do not add new text uses.

// Page gutter, named because the sticky SKU Detail header has to cancel it exactly.
// ⚠ MEASURED, NOT ASSUMED (2026-09-18): `position:sticky; top:0` inside a scroll
// container pins to the container's CONTENT box, i.e. BELOW its padding-top — the
// scroller's top edge read 37.4px while the pinned bar read 51.0px, leaving a ~14px
// strip where the page scrolled through above the bar. So the header uses
// `top:-PAGE_PAD_Y` to sit flush, and negative side margins to cover the gutters.
// Keep these as the single source or the two will drift and the leak returns.
export const PAGE_PAD_Y = 16, PAGE_PAD_X = 20;

export const S={
  app:{fontFamily:"Inter,sans-serif",background:HR.bg,height:"calc(100vh / 0.85)",color:HR.text,width:"100%",boxSizing:"border-box",overflowX:"hidden",display:"flex",flexDirection:"column"},
  header:{background:HR.white,borderBottom:`2px solid ${HR.yellow}`,padding:"0 16px",display:"flex",alignItems:"center",gap:6,height:44,boxShadow:"0 1px 4px rgba(0,0,0,0.08)",flexShrink:0,flexWrap:"nowrap",overflowX:"auto"},
  card:{background:HR.surface,borderRadius:8,padding:12,border:`1px solid ${HR.border}`,boxShadow:"0 1px 3px rgba(0,0,0,0.05)"},
  table:{width:"100%",borderCollapse:"collapse",fontSize:11},
  th:{padding:"6px 8px",textAlign:"left",color:HR.muted,background:HR.surfaceLight,fontWeight:600,fontSize:10,whiteSpace:"nowrap"},
  td:{padding:"4px 8px",borderTop:`1px solid ${HR.border}`},
  btn:(on)=>({padding:"4px 10px",borderRadius:6,border:`1px solid ${on?HR.yellow:HR.border}`,cursor:"pointer",fontSize:11,fontWeight:600,background:on?HR.yellow:HR.white,color:on?HR.black:HR.muted,transition:"all 0.15s",whiteSpace:"nowrap",outline:"none",flexShrink:0}),
  input:{background:HR.white,border:`1px solid ${HR.border}`,borderRadius:6,padding:"5px 10px",color:HR.text,fontSize:12},
  runBtn:{background:HR.yellow,color:HR.black,border:"none",padding:"10px 24px",borderRadius:8,cursor:"pointer",fontWeight:700,fontSize:13,width:"100%"},
  pageWrap:{flex:1,overflowY:"auto",overflowX:"hidden",padding:`${PAGE_PAD_Y}px ${PAGE_PAD_X}px`},
};

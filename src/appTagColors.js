// Tag colour maps + pill style, moved verbatim out of App.jsx so extracted tabs
// (src/tabs/LogicTweakerTab.jsx) render with the exact same values.

export const MOV_COLORS = {"Super Fast":"#16a34a","Fast":"#2D7A3A","Moderate":"#B8860B","Slow":"#C05A00","Super Slow":"#C0392B"};
export const PRICE_TAG_COLORS = {
  "Premium":{bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
  "High":{bg:"#FFEDD5",color:"#C2410C",border:"#FED7AA"},
  "Medium":{bg:"#FEF9C3",color:"#A16207",border:"#FDE68A"},
  "Low":{bg:"#F1F5F9",color:"#475569",border:"#CBD5E1"},
  "Super Low":{bg:"#F8FAFC",color:"#64748B",border:"#E2E8F0"},
  "No Price":{bg:"#F8FAFC",color:"#94A3B8",border:"#E2E8F0"},
};
export const TOPN_TAG_COLORS = {
  "T50":{bg:"#DCFCE7",color:"#15803D",border:"#BBF7D0"},
  "T150":{bg:"#D1FAE5",color:"#065F46",border:"#A7F3D0"},
  "T250":{bg:"#CFFAFE",color:"#0E7490",border:"#A5F3FC"},
  "No":{bg:"#F1F5F9",color:"#475569",border:"#CBD5E1"},
  "Zero Sale":{bg:"#FEE2E2",color:"#B91C1C",border:"#FECACA"},
};
export const TOPN_DISPLAY = { "T50":"Top 50","T150":"Top 150","T250":"Top 250","No":"Not Top","Zero Sale":"Zero Sale" };

export const TAG_STYLE = {padding:"1px 5px",borderRadius:3,fontSize:8,fontWeight:700,whiteSpace:"nowrap",lineHeight:"14px",display:"inline-block"};

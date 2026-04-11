// Engine constants — extracted from App.jsx
// UI constants (HR colors, DS_COLORS, MOV_COLORS, etc.) remain in App.jsx

export const ROLLING_DAYS = 90;
export const DS_LIST = ["DS01","DS02","DS03","DS04","DS05"];

export const MOVEMENT_TIERS_DEFAULT = [2,4,7,10];

export const DC_MULT_DEFAULT = {
  "Super Fast":{min:0.75,max:1.0},"Fast":{min:0.5,max:0.75},
  "Moderate":{min:0.5,max:0.75},"Slow":{min:0.25,max:0.5},"Super Slow":{min:0.25,max:0.5},
};
export const DC_DEAD_MULT_DEFAULT = {min:0.25,max:0.25};
export const RECENCY_WT_DEFAULT = {"Super Fast":2,"Fast":3,"Moderate":1.5,"Slow":1,"Super Slow":1};
export const BASE_MIN_DAYS_DEFAULT = {"Super Fast":6,"Fast":5,"Moderate":3,"Slow":3,"Super Slow":3};

export const DEFAULT_BRAND_BUFFER = {
  "Asian Paints":3,"VIP Extrusions":3,"MYK Laticrete":3,"Roff":3,
  "Supreme":3,"Saint-Gobain":2,"Alagar":3,"Legrand":1,"Archidply":1,
};

export const DEFAULT_PARAMS = {
  overallPeriod:90,recencyWindow:15,recencyWt:RECENCY_WT_DEFAULT,movIntervals:[2,4,7,10],
  priceTiers:[3000,1500,400,100],spikeMultiplier:5,spikePctFrequent:10,spikePctOnce:5,
  maxDaysBuffer:2,abqMaxMultiplier:1.5,baseMinDays:BASE_MIN_DAYS_DEFAULT,
  brandBuffer:DEFAULT_BRAND_BUFFER,newDSList:["DS04","DS05"],newDSFloorTopN:150,
  activeDSCount:4,dcMult:DC_MULT_DEFAULT,dcDeadMult:DC_DEAD_MULT_DEFAULT,
  categoryStrategies:{},
  percentileCover:{
    percentileByPrice:{"Low":95,"Super Low":95,"No Price":95,"Medium":85,"High":80,"Premium":75},
    coverDaysByMovement:{"Super Fast":2,"Fast":2,"Moderate":1,"Slow":1,"Super Slow":1},
  },
  fixedUnitFloor:{orderQtyPercentile:90, maxMultiplier:1.5, maxAdditive:1},
  brandLeadTimeDays:{_default:3},
  pctDocCap:30,
  pctDocCapPriceTags:["High","Premium"],
  pctMinNZD:2,
  skuFloorDCMultMin:0.2,
  skuFloorDCMultMax:0.3,
};

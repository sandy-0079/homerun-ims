/** Trigger a browser download of CSV text. Mirrors the `dlCSV` helper inside the Upload
 *  tab's block, which is out of scope on the Tool Output tab; kept separate rather than
 *  hoisting that one, so this change touches nothing in Upload. Shared by App.jsx's
 *  Tool Output tab and the Hyderabad tabs. */
export function downloadCsvFile(filename,csv){
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download=filename;
  a.click();
}

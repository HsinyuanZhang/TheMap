import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateData } from "./generate";

const outputDirectory = resolve("public/data");

async function build(): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const data = generateData();
  await Promise.all(Object.entries(data).map(async ([name, collection]) => {
    await writeFile(resolve(outputDirectory, name + ".geojson"), JSON.stringify(collection) + "\n", "utf8");
  }));
  const buildings = data.buildings!.features;
  const bids = new Set(buildings.map((item) => item.properties?.bid));
  console.log(
    "Generated " + Object.keys(data).length + " GeoJSON collections (" + bids.size
    + " distinct building bids, " + buildings.length + " building features).",
  );
}

await build();

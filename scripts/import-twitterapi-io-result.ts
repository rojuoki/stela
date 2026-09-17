import { importTwitterApiIoResult } from "../src/lib/io/import-result";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error(
    "Usage: npm run io:import -- results/twitterapi-io-1000/result.json",
  );
  process.exitCode = 1;
} else {
  const imported = importTwitterApiIoResult(inputPath);
  console.log(JSON.stringify(imported, null, 2));
}

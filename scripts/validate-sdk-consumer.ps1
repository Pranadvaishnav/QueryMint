[CmdletBinding()]
param(
  [string]$CoordinatorApiUrl = "https://querymint-production.up.railway.app",
  [string]$BuyerAddress = "0x9a8ddC340C5461a20a0EB731D4fa6C8E484cbb5A",
  [string]$SettlementAddress = "0xb40363F6F9C1bEECf386C5C8440A826Ed9b9c854"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$tempRoot = [System.IO.Path]::GetTempPath()
$tempDirectory = Join-Path $tempRoot ("querymint-sdk-consumer-" + [guid]::NewGuid().ToString("N"))
$consumerDirectory = Join-Path $tempDirectory "consumer"
New-Item -ItemType Directory -Path $consumerDirectory -Force | Out-Null
$npmCache = Join-Path $tempDirectory "npm-cache"

if ($BuyerAddress -notmatch '^0x[0-9a-fA-F]{40}$') { throw "BuyerAddress must be a public EVM address." }
if ($SettlementAddress -notmatch '^0x[0-9a-fA-F]{40}$') { throw "SettlementAddress must be a public EVM address." }
if (-not ([uri]$CoordinatorApiUrl).IsAbsoluteUri -or ([uri]$CoordinatorApiUrl).Scheme -ne "https") { throw "CoordinatorApiUrl must be an HTTPS URL." }

Push-Location $repoRoot
try {
  npm run build --workspace @querymint/sdk
  if ($LASTEXITCODE -ne 0) { throw "Workspace SDK build failed." }

  Push-Location (Join-Path $repoRoot "packages/shared")
  try {
    npm pack --cache $npmCache --pack-destination $tempDirectory
    if ($LASTEXITCODE -ne 0) { throw "Packing @querymint/shared failed." }
  } finally { Pop-Location }

  Push-Location (Join-Path $repoRoot "packages/sdk")
  try {
    npm pack --cache $npmCache --pack-destination $tempDirectory
    if ($LASTEXITCODE -ne 0) { throw "Packing @querymint/sdk failed." }
  } finally { Pop-Location }
} finally { Pop-Location }

$sharedTarball = Join-Path $tempDirectory "querymint-shared-0.1.0.tgz"
$sdkTarball = Join-Path $tempDirectory "querymint-sdk-0.1.0.tgz"
if (-not (Test-Path -LiteralPath $sharedTarball) -or -not (Test-Path -LiteralPath $sdkTarball)) { throw "Expected package tarball was not produced." }
Write-Output "Packed both public package tarballs."

$packageJson = @'
{
  "name": "querymint-sdk-independent-consumer",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "tsc --noEmit && vite build" }
}
'@
Set-Content -LiteralPath (Join-Path $consumerDirectory "package.json") -Value $packageJson -Encoding utf8
New-Item -ItemType Directory -Path (Join-Path $consumerDirectory "src") -Force | Out-Null

$indexHtml = @'
<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>QueryMint SDK Consumer</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
'@
Set-Content -LiteralPath (Join-Path $consumerDirectory "index.html") -Value $indexHtml -Encoding utf8

$tsconfig = @'
{"compilerOptions":{"target":"ES2022","useDefineForClassFields":true,"module":"ESNext","lib":["ES2022","DOM","DOM.Iterable"],"skipLibCheck":true,"moduleResolution":"Bundler","allowImportingTsExtensions":true,"resolveJsonModule":true,"isolatedModules":true,"noEmit":true,"jsx":"react-jsx","strict":true,"types":["vite/client"]},"include":["src"]}
'@
Set-Content -LiteralPath (Join-Path $consumerDirectory "tsconfig.json") -Value $tsconfig -Encoding utf8

$appSource = @'
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createQueryMint, whitechainSepolia, type QueryMintQuote } from "@querymint/sdk";
import type { Address, PublicClient, WalletClient } from "viem";

const apiUrl = import.meta.env.VITE_COORDINATOR_API_URL;
const settlementAddress = import.meta.env.VITE_QUERYMINT_SETTLEMENT_ADDRESS as Address;
const buyer = import.meta.env.VITE_TEST_BUYER_ADDRESS as Address;
const querymint = createQueryMint({ apiUrl, settlementAddress, walletClient: { account: { address: buyer } } as unknown as WalletClient, publicClient: {} as PublicClient });

function App() {
  const [quote, setQuote] = useState<QueryMintQuote | null>(null);
  const [status, setStatus] = useState(`Chain ${whitechainSepolia.id}; request a quote to verify SDK import.`);
  async function requestQuote() {
    try {
      const next = await querymint.quote({ where: { category: "defi" }, limit: 20 });
      setQuote(next);
      setStatus(`Validated quote: ${next.manifest.allocations.length} allocations, ${next.eligibleRecords} eligible records.`);
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Quote request failed"); }
  }
  return <main><h1>QueryMint SDK consumer</h1><p>{status}</p><button onClick={() => void requestQuote()}>Request quote</button>{quote && <ul>{quote.breakdown.map((row) => <li key={row.datasetId}>{row.publisher}: {row.recordCount} records, {row.payoutAmount} USDT base units</li>)}</ul>}</main>;
}
createRoot(document.getElementById("root")!).render(<App />);
'@
Set-Content -LiteralPath (Join-Path $consumerDirectory "src/main.tsx") -Value $appSource -Encoding utf8

$quoteScript = @'
import { createQueryMint } from "@querymint/sdk";
const [apiUrl, buyer, settlementAddress] = process.argv.slice(2);
if (!apiUrl || !/^0x[0-9a-fA-F]{40}$/.test(buyer ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(settlementAddress ?? "")) throw new Error("Pass coordinator HTTPS URL, public buyer address, and settlement address.");
const sdk = createQueryMint({ apiUrl, settlementAddress, walletClient: { account: { address: buyer } }, publicClient: {} });
try {
  const quote = await sdk.quote({ where: { category: "defi" }, limit: 20 });
  console.log(JSON.stringify({ ok: true, allocations: quote.manifest.allocations.length, records: quote.eligibleRecords, totalAmountBaseUnits: quote.manifest.totalAmount.toString(), signatureValidated: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, errorName: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
}
'@
Set-Content -LiteralPath (Join-Path $consumerDirectory "verify-quote.mjs") -Value $quoteScript -Encoding utf8

Push-Location $consumerDirectory
try {
  Write-Output "Installing tarballs and Vite/React dependencies into the external temp consumer."
  npm install --cache $npmCache --ignore-scripts --no-audit --no-fund $sharedTarball $sdkTarball "react@19.2.9" "react-dom@19.2.9" "@types/react@19.2.7" "@types/react-dom@19.2.3" "vite@7.3.7" "typescript@5.9.3"
  if ($LASTEXITCODE -ne 0) { throw "Installing packed SDK into the independent consumer failed." }
  $env:VITE_COORDINATOR_API_URL = $CoordinatorApiUrl
  $env:VITE_QUERYMINT_SETTLEMENT_ADDRESS = $SettlementAddress
  $env:VITE_TEST_BUYER_ADDRESS = $BuyerAddress
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Independent Vite consumer build failed." }
  Write-Output "Independent Vite build passed; making read-only quote request."
  node verify-quote.mjs $CoordinatorApiUrl $BuyerAddress $SettlementAddress
  if ($LASTEXITCODE -ne 0) { throw "Independent consumer quote request failed." }
} finally { Pop-Location }

Write-Output "Independent Vite consumer directory: $consumerDirectory"

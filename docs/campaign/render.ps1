# Benchmark Scout — campaign card renderer
#
# Renders each card HTML to a PNG at its exact platform dimensions using
# headless Edge/Chrome. No dependencies beyond a Chromium browser.
#
# Requires the "campaign-cards" static server (see .claude/launch.json) on :4321.
# Usage:  py -m http.server 4321 --directory docs/campaign
#         pwsh docs/campaign/render.ps1

param(
  [string]$BaseUrl = "http://localhost:4321",
  [string]$OutDir = "$PSScriptRoot\out"
)

$browser = @(
  "C:\Program Files\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $browser) { throw "No Chromium browser found for rendering." }

# card file -> output size. Sizes must match the .frame--* class used in the HTML.
$cards = @(
  @{ file = "card-day01.html"; out = "day01-launch-1080x1350.png";    w = 1080; h = 1350 },
  @{ file = "card-day02.html"; out = "day02-demo-1080x1350.png";      w = 1080; h = 1350 },
  @{ file = "card-day03.html"; out = "day03-agencies-1080x1350.png";  w = 1080; h = 1350 },
  @{ file = "card-day04.html"; out = "day04-mythbust-1080x1350.png";  w = 1080; h = 1350 },
  @{ file = "card-day05.html"; out = "day05-leadgen-1080x1080.png";   w = 1080; h = 1080 },
  @{ file = "card-day06.html"; out = "day06-whatyouget-1080x1350.png";w = 1080; h = 1350 },
  @{ file = "card-day07.html"; out = "day07-founding100-1080x1350.png"; w = 1080; h = 1350 },
  @{ file = "card-day08.html"; out = "day08-buildinpublic-1080x1350.png"; w = 1080; h = 1350 },
  @{ file = "card-day09.html"; out = "day09-recon-1080x1080.png";     w = 1080; h = 1080 },
  @{ file = "card-day10.html"; out = "day10-rerun-1080x1350.png";     w = 1080; h = 1350 },
  @{ file = "card-day11.html"; out = "day11-agency-1080x1350.png";    w = 1080; h = 1350 },
  @{ file = "card-day12.html"; out = "day12-urgency-1080x1920.png";   w = 1080; h = 1920 },
  @{ file = "card-day13.html"; out = "day13-feedback-1080x1350.png";  w = 1080; h = 1350 },
  @{ file = "card-day14.html"; out = "day14-recap-1080x1350.png";     w = 1080; h = 1350 },
  @{ file = "card-og.html";    out = "og-share-1200x630.png";         w = 1200; h = 630  }
)

New-Item -ItemType Directory -Force $OutDir | Out-Null

foreach ($c in $cards) {
  $target = Join-Path $OutDir $c.out
  if (Test-Path $target) { Remove-Item $target -Force }

  & $browser `
    --headless=new `
    --disable-gpu `
    --hide-scrollbars `
    --force-device-scale-factor=1 `
    --window-size="$($c.w),$($c.h)" `
    --virtual-time-budget=10000 `
    --screenshot="$target" `
    "$BaseUrl/$($c.file)" 2>$null | Out-Null

  if (Test-Path $target) {
    $kb = [math]::Round((Get-Item $target).Length / 1KB)
    Write-Output "OK   $($c.out)  ($($c.w)x$($c.h), ${kb}KB)"
  } else {
    Write-Output "FAIL $($c.out)"
  }
}

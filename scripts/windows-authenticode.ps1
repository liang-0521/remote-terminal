[CmdletBinding()]
param(
    [ValidateSet("Preflight", "Sign", "Verify", "SelfTest")]
    [string]$Mode = "Sign",

    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$CodeSigningEku = "1.3.6.1.5.5.7.3.3"
$CertificateThumbprintVariable = "REMOTE_TERMINAL_AUTHENTICODE_CERTIFICATE_THUMBPRINT"
$TimestampUrlVariable = "REMOTE_TERMINAL_AUTHENTICODE_TIMESTAMP_URL"
$SignToolPathVariable = "REMOTE_TERMINAL_SIGNTOOL_PATH"

function Throw-AuthenticodeError {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Code,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    throw "[$Code] $Message"
}

function Get-RequiredEnvironmentValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CONFIG_MISSING" -Message $Message
    }
    return $value.Trim()
}

function Normalize-CertificateThumbprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $normalized = ($Value -replace '\s', '').ToUpperInvariant()
    if ($normalized -notmatch '^[0-9A-F]{40}$') {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CONFIG_INVALID" -Message "The code-signing certificate thumbprint must be a 40-character hexadecimal SHA-1 thumbprint."
    }
    return $normalized
}

function Normalize-TimestampUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @("http", "https") -or
        [string]::IsNullOrWhiteSpace($uri.Host) -or
        -not [string]::IsNullOrEmpty($uri.UserInfo)) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CONFIG_INVALID" -Message "The timestamp server must be an absolute HTTP or HTTPS URL without user information."
    }
    return $uri.AbsoluteUri
}

function Resolve-SignTool {
    $configuredPath = [Environment]::GetEnvironmentVariable($SignToolPathVariable, "Process")
    if (-not [string]::IsNullOrWhiteSpace($configuredPath)) {
        $candidate = [IO.Path]::GetFullPath($configuredPath.Trim())
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            Throw-AuthenticodeError -Code "SIGNTOOL_NOT_FOUND" -Message "The configured SignTool executable does not exist."
        }
        return $candidate
    }

    $command = Get-Command "signtool.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        return $command.Source
    }

    $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
    $windowsKitsBin = Join-Path $programFilesX86 "Windows Kits\10\bin"
    if (Test-Path -LiteralPath $windowsKitsBin -PathType Container) {
        $candidates = @(
            Get-ChildItem -LiteralPath $windowsKitsBin -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending |
                ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" }
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }

    Throw-AuthenticodeError -Code "SIGNTOOL_NOT_FOUND" -Message "Windows SDK SignTool was not found."
}

function Get-CodeSigningCertificate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Thumbprint
    )

    $certificate = Get-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
    if ($null -eq $certificate) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CERTIFICATE_NOT_FOUND" -Message "The configured code-signing certificate is not available in the current Windows user certificate store."
    }
    if (-not $certificate.HasPrivateKey) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CERTIFICATE_INVALID" -Message "The code-signing certificate has no accessible private key."
    }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CERTIFICATE_INVALID" -Message "The code-signing certificate is not currently valid."
    }
    if ($certificate.Subject -eq $certificate.Issuer) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CERTIFICATE_UNTRUSTED" -Message "Release builds must not use a self-signed code-signing certificate."
    }

    $ekuExtension = $certificate.Extensions |
        Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
        Select-Object -First 1
    $enhancedKeyUsages = if ($null -eq $ekuExtension) {
        @()
    } else {
        @($ekuExtension.EnhancedKeyUsages | ForEach-Object { $_.Value })
    }
    if ($enhancedKeyUsages -notcontains $CodeSigningEku) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CERTIFICATE_INVALID" -Message "The configured certificate is not valid for code signing."
    }
    return $certificate
}

function Resolve-AuthenticodeTarget {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_TARGET_INVALID" -Message "A Windows executable target is required."
    }
    $resolved = [IO.Path]::GetFullPath($Value)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or
        [IO.Path]::GetExtension($resolved) -ine ".exe") {
        Throw-AuthenticodeError -Code "AUTHENTICODE_TARGET_INVALID" -Message "Authenticode operations only accept an existing Windows EXE file."
    }
    return $resolved
}

function Get-AuthenticodePreflight {
    $thumbprint = Normalize-CertificateThumbprint (Get-RequiredEnvironmentValue `
        -Name $CertificateThumbprintVariable `
        -Message "The code-signing certificate thumbprint is missing.")
    $timestampUrl = Normalize-TimestampUrl (Get-RequiredEnvironmentValue `
        -Name $TimestampUrlVariable `
        -Message "The Authenticode timestamp server URL is missing.")
    $certificate = Get-CodeSigningCertificate -Thumbprint $thumbprint
    $signTool = Resolve-SignTool

    return [pscustomobject]@{
        Thumbprint = $thumbprint
        TimestampUrl = $timestampUrl
        Certificate = $certificate
        SignTool = $signTool
    }
}

function Assert-TrustedAuthenticodeSignature {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Target,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedThumbprint,

        [string]$SignTool
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $Target
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or
        $null -eq $signature.SignerCertificate) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_VERIFY_FAILED" -Message "Windows did not validate the Authenticode signature."
    }
    if ($signature.SignerCertificate.Subject -eq $signature.SignerCertificate.Issuer) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_CERTIFICATE_UNTRUSTED" -Message "Release builds must not use a self-signed code-signing certificate."
    }
    $actualThumbprint = Normalize-CertificateThumbprint $signature.SignerCertificate.Thumbprint
    if ($actualThumbprint -cne $ExpectedThumbprint) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_SIGNER_MISMATCH" -Message "The Authenticode signer does not match the configured release identity."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_TIMESTAMP_MISSING" -Message "The Authenticode signature has no trusted timestamp."
    }

    $resolvedSignTool = if ([string]::IsNullOrWhiteSpace($SignTool)) {
        Resolve-SignTool
    } else {
        $SignTool
    }
    & $resolvedSignTool verify /pa /all /tw $Target *> $null
    if ($LASTEXITCODE -ne 0) {
        Throw-AuthenticodeError -Code "AUTHENTICODE_VERIFY_FAILED" -Message "SignTool did not validate the file under the Windows Authenticode policy."
    }
}

function Invoke-SelfTest {
    $expectedThumbprint = "00112233445566778899AABBCCDDEEFF00112233"
    $normalizedThumbprint = Normalize-CertificateThumbprint "00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33"
    if ($normalizedThumbprint -cne $expectedThumbprint) {
        throw "thumbprint normalization self-test failed"
    }

    $invalidThumbprintRejected = $false
    try {
        [void](Normalize-CertificateThumbprint "not-a-thumbprint")
    } catch {
        $invalidThumbprintRejected = $_.Exception.Message -match '^\[AUTHENTICODE_CONFIG_INVALID\]'
    }
    if (-not $invalidThumbprintRejected) {
        throw "invalid thumbprint self-test failed"
    }

    $timestampUrl = Normalize-TimestampUrl "https://timestamp.example.test/"
    if ($timestampUrl -cne "https://timestamp.example.test/") {
        throw "timestamp URL self-test failed"
    }

    $unsafeTimestampRejected = $false
    try {
        [void](Normalize-TimestampUrl "file:///temporary/timestamp")
    } catch {
        $unsafeTimestampRejected = $_.Exception.Message -match '^\[AUTHENTICODE_CONFIG_INVALID\]'
    }
    if (-not $unsafeTimestampRejected) {
        throw "unsafe timestamp URL self-test failed"
    }

    [pscustomobject]@{
        passed = $true
        digestAlgorithm = "sha256"
        rejectsInvalidThumbprints = $true
        rejectsUnsafeTimestampUrls = $true
    } | ConvertTo-Json -Compress
}

switch ($Mode) {
    "SelfTest" {
        Invoke-SelfTest
        break
    }
    "Preflight" {
        [void](Get-AuthenticodePreflight)
        Write-Output "Authenticode signing identity and timestamp configuration verified."
        break
    }
    "Sign" {
        $target = Resolve-AuthenticodeTarget -Value $Path
        $preflight = Get-AuthenticodePreflight
        & $preflight.SignTool sign /sha1 $preflight.Thumbprint /s My /fd SHA256 /tr $preflight.TimestampUrl /td SHA256 /d "Remote Terminal" $target *> $null
        if ($LASTEXITCODE -ne 0) {
            Throw-AuthenticodeError -Code "AUTHENTICODE_SIGN_FAILED" -Message "Windows Authenticode signing failed."
        }
        Assert-TrustedAuthenticodeSignature -Target $target -ExpectedThumbprint $preflight.Thumbprint -SignTool $preflight.SignTool
        Write-Output "Authenticode SHA-256 signature and timestamp verified."
        break
    }
    "Verify" {
        $target = Resolve-AuthenticodeTarget -Value $Path
        $expectedThumbprint = Normalize-CertificateThumbprint (Get-RequiredEnvironmentValue `
            -Name $CertificateThumbprintVariable `
            -Message "The expected code-signing certificate thumbprint is missing.")
        Assert-TrustedAuthenticodeSignature -Target $target -ExpectedThumbprint $expectedThumbprint
        Write-Output "Authenticode signature and timestamp verified."
        break
    }
}

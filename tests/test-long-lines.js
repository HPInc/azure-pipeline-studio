#!/usr/bin/env node

const { formatYaml } = require('../extension.js');
const fs = require('fs');
const path = require('path');

console.log('🔗 Testing Long Line Preservation');
console.log('=================================\n');

let testCount = 0;
let passCount = 0;

function runTest(testName, testFn) {
    testCount++;
    console.log(`📋 Test ${testCount}: ${testName}`);
    try {
        const result = testFn();
        if (result) {
            passCount++;
            console.log('✅ PASS\n');
        } else {
            console.log('❌ FAIL\n');
        }
    } catch (error) {
        console.log(`❌ FAIL - ${error.message}\n`);
    }
}

// Test 1: Long Command Line Preservation
runTest('Long Command Line in Bash Script', () => {
    const input = `steps:
- bash: |
    dotnet test --configuration Release --logger trx --collect:"XPlat Code Coverage" --results-directory TestResults/ --settings coverlet.runsettings
  displayName: Run Tests with Coverage`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 100);

    console.log(`   Found ${longLines.length} long lines (>100 chars)`);
    console.log(`   Longest line: ${Math.max(...result.text.split('\n').map((l) => l.length))} chars`);

    return longLines.length > 0 && result.text.includes('XPlat Code Coverage');
});

// Test 2: Long File Path Preservation
runTest('Long File Paths', () => {
    const input = `steps:
- task: PublishBuildArtifacts@1
  displayName: Publish Artifacts
  inputs:
    PathtoPublish: '$(Build.SourcesDirectory)/src/MyVeryLongProjectNameWithManyFolders/bin/Release/netcoreapp3.1/publish'
    ArtifactName: 'application-artifacts-for-deployment-to-production-environment'`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 80);

    console.log(`   Found ${longLines.length} long lines (>80 chars)`);

    return (
        longLines.length > 0 &&
        result.text.includes('MyVeryLongProjectNameWithManyFolders') &&
        result.text.includes('application-artifacts-for-deployment')
    );
});

// Test 3: Long URL Preservation
runTest('Long URLs and Connection Strings', () => {
    const input = `variables:
  connectionString: 'Server=tcp:my-very-long-server-name.database.windows.net,1433;Initial Catalog=MyDatabaseWithLongName;Persist Security Info=False;User ID=admin;Password=$(dbPassword);MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;'
  apiEndpoint: 'https://api.mycompany.com/v2/services/data-processing/endpoints/bulk-operations/upload-large-datasets'
steps:
- bash: |
    curl -X POST "$(apiEndpoint)" -H "Authorization: Bearer $(token)"
  displayName: Call API`;

    const result = formatYaml(input);
    const veryLongLines = result.text.split('\n').filter((line) => line.length > 150);

    console.log(`   Found ${veryLongLines.length} very long lines (>150 chars)`);

    return (
        veryLongLines.length > 0 &&
        result.text.includes('database.windows.net') &&
        result.text.includes('bulk-operations')
    );
});

// Test 4: Python Code with Long Lines
runTest('Python Code Long Lines', () => {
    const input = `steps:
- task: PythonScript@0
  inputs:
    scriptSource: 'inline'
    script: |
      import json
      import os
      from azure.storage.blob import BlobServiceClient, BlobClient, ContainerClient
      
      # This is a very long comment explaining the complex data processing logic that needs to happen in this script
      def process_large_dataset(data_items, configuration_settings, output_directory, processing_options):
          """Process a large dataset with multiple configuration options and detailed logging for troubleshooting purposes."""
          for item in data_items:
              if item.get('status') == 'active' and item.get('type') in ['critical', 'important', 'high-priority']:
                  result = complex_processing_function(item, configuration_settings, processing_options)
                  write_output_file(os.path.join(output_directory, f"processed_{item['id']}.json"), result)
      
      connection_string = "DefaultEndpointsProtocol=https;AccountName=mystorageaccount;AccountKey=verylongaccountkeyhere;EndpointSuffix=core.windows.net"
  displayName: 'Process Data with Python'`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 120);

    console.log(`   Found ${longLines.length} long lines in Python code`);

    return (
        longLines.length > 0 &&
        result.text.includes('complex_processing_function') &&
        result.text.includes('DefaultEndpointsProtocol=https')
    );
});

// Test 5: PowerShell Command Long Lines
runTest('PowerShell Long Commands', () => {
    const input = `steps:
- powershell: |
    $connectionString = "Server=tcp:myserver.database.windows.net,1433;Initial Catalog=MyDatabase;Persist Security Info=False;User ID=myuser;Password=$(password);MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;"
    
    Invoke-RestMethod -Uri "https://api.example.com/v1/data/upload/bulk/process" -Method POST -Headers @{"Authorization"="Bearer $(token)"; "Content-Type"="application/json"} -Body $jsonPayload
    
    Get-ChildItem -Path "$(Build.SourcesDirectory)" -Recurse -Include "*.dll", "*.exe", "*.config" | Where-Object { $_.LastWriteTime -gt (Get-Date).AddDays(-1) }
  displayName: 'PowerShell Long Commands'`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 100);

    console.log(`   Found ${longLines.length} long PowerShell lines`);

    return longLines.length > 0 && result.text.includes('Invoke-RestMethod') && result.text.includes('Get-ChildItem');
});

// Test 6: YAML Values with Long Strings
runTest('Long YAML String Values', () => {
    const input = `variables:
  longDescription: 'This is a very long description that explains the purpose of this pipeline and all the various stages and jobs that it contains, including build, test, and deployment phases'
  buildArguments: '--configuration Release --output $(Build.ArtifactStagingDirectory) --verbosity detailed --logger console --no-restore --no-dependencies'
  deploymentNotes: 'Deployment includes database migrations, configuration updates, service restarts, health checks, rollback procedures, monitoring setup, and notification systems'
steps:
- bash: echo "$(longDescription)"
  displayName: Show Description`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 100);

    console.log(`   Found ${longLines.length} long YAML value lines`);

    return (
        longLines.length > 0 &&
        result.text.includes('various stages and jobs') &&
        result.text.includes('--no-dependencies')
    );
});

// Test 7: Mixed Long Content
runTest('Mixed Long Content Types', () => {
    const input = `# This pipeline demonstrates various types of long content that should not be wrapped by the YAML formatter
trigger:
  branches:
    include:
    - main
    - feature/implement-complex-data-processing-with-multiple-stages-and-error-handling
variables:
  complexConnectionString: 'Server=tcp:very-long-server-name.database.windows.net,1433;Initial Catalog=MyDatabaseWithVeryLongName;Persist Security Info=False;User ID=admin;Password=$(password);MultipleActiveResultSets=False;Encrypt=True;TrustServerCertificate=False;Connection Timeout=30;'
steps:
- bash: |
    echo "Starting complex processing with many parameters and long command line arguments"
    dotnet run --project MyProject.csproj --configuration Release --runtime win-x64 --self-contained true --output ./publish/release/win-x64/
  displayName: 'Complex Build with Long Parameters'
- task: AzureWebApp@1
  inputs:
    azureSubscription: 'production-subscription-for-web-applications-and-services'
    appName: 'my-application-with-very-long-descriptive-name-for-production'
    package: '$(Build.ArtifactStagingDirectory)/publish/release/win-x64/'`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 80);

    console.log(`   Found ${longLines.length} long lines across different content types`);

    return (
        longLines.length >= 3 &&
        result.text.includes('implement-complex-data-processing') &&
        result.text.includes('very-long-server-name') &&
        result.text.includes('--self-contained true')
    );
});

// Test 8: Line Width Configuration
runTest('Custom Line Width Setting', () => {
    const input = `steps:
- bash: |
    echo "This line is moderately long but should not be wrapped when using unlimited line width setting"
  displayName: Test Line Width`;

    // Test with explicit lineWidth setting
    const result = formatYaml(input, { lineWidth: -1 });

    console.log(`   Custom lineWidth handled without error: ${!result.error}`);
    console.log(`   Content preserved: ${result.text.includes('moderately long')}`);

    return !result.error && result.text.includes('moderately long');
});

// Test 9: Very Long Single Line
runTest('Extremely Long Single Line', () => {
    const extremelyLongLine = 'a'.repeat(500);
    const input = `steps:
- bash: |
    echo "${extremelyLongLine}"
  displayName: Extreme Length Test`;

    const result = formatYaml(input);

    console.log(`   Extremely long line preserved: ${result.text.includes(extremelyLongLine)}`);
    console.log(`   No error occurred: ${!result.error}`);

    return result.text.includes(extremelyLongLine) && !result.error;
});

// Test 10: Long Lines with Special Characters
runTest('Long Lines with Special Characters', () => {
    const input = `steps:
- bash: |
    curl -X POST "https://api.example.com/webhook" -H "Content-Type: application/json" -d '{"message":"Build completed successfully! 🎉 All tests passed ✅ Ready for deployment 🚀","status":"success","details":{"build":"$(Build.BuildNumber)","branch":"$(Build.SourceBranchName)","commit":"$(Build.SourceVersion)"}}'
  displayName: 'Webhook Notification with Emojis'`;

    const result = formatYaml(input);
    const longLines = result.text.split('\n').filter((line) => line.length > 100);

    console.log(`   Found ${longLines.length} long lines with special characters`);
    console.log(`   Emojis preserved: ${result.text.includes('🎉') && result.text.includes('✅')}`);

    return longLines.length > 0 && result.text.includes('🎉') && result.text.includes('Build.BuildNumber');
});

// Final Results
console.log('🏁 LONG LINE PRESERVATION TEST RESULTS');
console.log('======================================');
console.log(`Total Tests: ${testCount}`);
console.log(`✅ Passed: ${passCount}`);
console.log(`❌ Failed: ${testCount - passCount}`);
console.log(`📊 Success Rate: ${Math.round((passCount / testCount) * 100)}%\n`);

if (passCount === testCount) {
    console.log('🎉 ALL LONG LINE TESTS PASSED!');
    process.exit(0);
} else {
    console.log('❌ Some long line tests failed.');
    process.exit(1);
}

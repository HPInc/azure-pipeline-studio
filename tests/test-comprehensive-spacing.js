#!/usr/bin/env node

/**
 * Comprehensive spacing tests combining:
 * 1. Stage and job list spacing
 * 2. Multiline sibling spacing
 * 3. Variables section with conditionals (no unwanted blanks)
 * 4. Nested section spacing (dependsOn, parameters - no blanks)
 * 5. Blank preservation between steps in main sections
 *
 * Tests verify correct blank line handling across all spacing contexts
 */

const { formatYaml } = require('../formatter.js');
const assert = require('assert');

console.log('🧪 Comprehensive Spacing Tests\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, input, expected, options = { stepSpacing: true }) {
    totalTests++;
    try {
        const result = formatYaml(input, options);
        assert.strictEqual(result.text.trimEnd(), expected.trimEnd(), 'Mismatch in ' + name);
        console.log('✅ PASS - ' + name);
        passedTests++;
    } catch (error) {
        console.log('❌ FAIL - ' + name);
        console.log('   Error: ' + error.message + '\n');
    }
}

// ============================================================
// SECTION 1: Stage and Job Spacing Tests
// ============================================================
console.log('📍 Stage and Job Spacing Tests');

runTest(
    'Stage items have blank lines between siblings',
    'stages:\n- stage: Build\n  jobs:\n  - job: BuildJob\n    steps:\n    - script: echo Build\n- stage: Test\n  jobs:\n  - job: TestJob\n    steps:\n    - script: echo Test',
    'stages:\n- stage: Build\n  jobs:\n  - job: BuildJob\n    steps:\n    - script: echo Build\n\n- stage: Test\n  jobs:\n  - job: TestJob\n    steps:\n    - script: echo Test'
);

runTest(
    'Job items have blank lines between siblings',
    'jobs:\n- job: BuildJob\n  steps:\n  - script: echo Build\n- job: TestJob\n  steps:\n  - script: echo Test',
    'jobs:\n- job: BuildJob\n  steps:\n  - script: echo Build\n\n- job: TestJob\n  steps:\n  - script: echo Test'
);

runTest(
    'No duplicate blank lines when one already exists',
    'stages:\n- stage: Build\n  jobs:\n  - job: BuildJob\n    steps:\n    - script: echo Build\n\n- stage: Test\n  jobs:\n  - job: TestJob\n    steps:\n    - script: echo Test',
    'stages:\n- stage: Build\n  jobs:\n  - job: BuildJob\n    steps:\n    - script: echo Build\n\n- stage: Test\n  jobs:\n  - job: TestJob\n    steps:\n    - script: echo Test'
);

// ============================================================
// SECTION 2: Conditional Stages
// ============================================================

runTest(
    'Conditional stage items with blank lines',
    'stages:\n- ${{ if eq(parameters.build, true) }}:\n  - stage: Build\n    jobs:\n    - job: BuildJob\n      steps:\n      - script: echo Build\n- ${{ if eq(parameters.test, true) }}:\n  - stage: Test\n    jobs:\n    - job: TestJob\n      steps:\n      - script: echo Test',
    'stages:\n- ${{ if eq(parameters.build, true) }}:\n  - stage: Build\n    jobs:\n    - job: BuildJob\n      steps:\n      - script: echo Build\n\n- ${{ if eq(parameters.test, true) }}:\n  - stage: Test\n    jobs:\n    - job: TestJob\n      steps:\n      - script: echo Test'
);

runTest(
    'Multiple stages with mixed conditionals',
    'stages:\n- ${{ if eq(parameters.build, true) }}:\n  - stage: Build\n    jobs:\n    - job: BuildJob\n      steps:\n      - script: echo Build\n- ${{ if eq(parameters.test, true) }}:\n  - stage: Test\n    jobs:\n    - job: TestJob\n      steps:\n      - script: echo Test\n- stage: Deploy\n  jobs:\n  - job: DeployJob\n    steps:\n    - script: echo Deploy',
    'stages:\n- ${{ if eq(parameters.build, true) }}:\n  - stage: Build\n    jobs:\n    - job: BuildJob\n      steps:\n      - script: echo Build\n\n- ${{ if eq(parameters.test, true) }}:\n  - stage: Test\n    jobs:\n    - job: TestJob\n      steps:\n      - script: echo Test\n\n- stage: Deploy\n  jobs:\n  - job: DeployJob\n    steps:\n    - script: echo Deploy'
);

// ============================================================
// SECTION 3: Multiline Sibling Spacing Tests
// ============================================================
console.log('\n📍 Multiline Sibling Spacing Tests');

runTest(
    'Sibling templates inside conditionals have blank lines',
    'steps:\n- ${{ if parameters.enableMsixSigning }}:\n  - template: /steps/template-one.yaml\n    parameters:\n      param1: value1\n  - template: /steps/template-two.yaml\n    parameters:\n      param2: value2\n  - template: /steps/template-three.yaml\n    parameters:\n      param3: value3\n- bash: echo "After conditional block"',
    'steps:\n- ${{ if parameters.enableMsixSigning }}:\n  - template: /steps/template-one.yaml\n    parameters:\n      param1: value1\n\n  - template: /steps/template-two.yaml\n    parameters:\n      param2: value2\n\n  - template: /steps/template-three.yaml\n    parameters:\n      param3: value3\n\n- bash: echo "After conditional block"'
);

runTest(
    'Bash multiline followed by control structure has blank line',
    'steps:\n- ${{ if parameters.publishArtifacts }}:\n  - bash: |\n      echo "Publishing artifacts"\n      zip_dir="$(pwd)/artifacts"\n      mkdir -p "${zip_dir}"\n      cp *.zip "${zip_dir}/"\n    displayName: Stage Artifacts\n  - ${{ each connection in split(parameters.connections, \',\') }}:\n    - ${{ if ne(trim(connection), \'\') }}:\n      - task: PublishTask@0\n        inputs:\n          connection: ${{ connection }}\n- bash: echo "Final step"',
    'steps:\n- ${{ if parameters.publishArtifacts }}:\n  - bash: |\n      echo "Publishing artifacts"\n      zip_dir="$(pwd)/artifacts"\n      mkdir -p "${zip_dir}"\n      cp *.zip "${zip_dir}/"\n    displayName: Stage Artifacts\n\n  - ${{ each connection in split(parameters.connections, \',\') }}:\n    - ${{ if ne(trim(connection), \'\') }}:\n      - task: PublishTask@0\n        inputs:\n          connection: ${{ connection }}\n\n- bash: echo "Final step"'
);

runTest(
    'Control structures (if/elseif/each) as siblings',
    'steps:\n- task: Setup@1\n  displayName: Setup\n- ${{ if eq(parameters.option, \'A\') }}:\n  - bash: echo "Option A"\n- ${{ elseif eq(parameters.option, \'B\') }}:\n  - bash: echo "Option B"\n- ${{ each config in parameters.configurations }}:\n  - task: Process@1\n    inputs:\n      config: ${{ config }}\n- bash: echo "Cleanup"',
    'steps:\n- task: Setup@1\n  displayName: Setup\n\n- ${{ if eq(parameters.option, \'A\') }}:\n  - bash: echo "Option A"\n\n- ${{ elseif eq(parameters.option, \'B\') }}:\n  - bash: echo "Option B"\n\n- ${{ each config in parameters.configurations }}:\n  - task: Process@1\n    inputs:\n      config: ${{ config }}\n\n- bash: echo "Cleanup"'
);

runTest(
    'Nested parent-child conditionals do NOT have blanks',
    "stages:\n- ${{ if eq(parameters.enableBuild, true) }}:\n  - ${{ if eq(parameters.enableTests, true) }}:\n    - stage: BuildAndTest\n      jobs:\n      - job: Test\n- ${{ if eq(parameters.enableDeploy, true) }}:\n  - ${{ if eq(parameters.environment, 'prod') }}:\n    - stage: ProdDeploy\n- stage: AlwaysRun",
    "stages:\n- ${{ if eq(parameters.enableBuild, true) }}:\n  - ${{ if eq(parameters.enableTests, true) }}:\n    - stage: BuildAndTest\n      jobs:\n      - job: Test\n\n- ${{ if eq(parameters.enableDeploy, true) }}:\n  - ${{ if eq(parameters.environment, 'prod') }}:\n    - stage: ProdDeploy\n\n- stage: AlwaysRun"
);

runTest(
    'Regular step siblings have blank lines',
    "steps:\n- task: NodeTool@0\n  inputs:\n    versionSpec: '18.x'\n- bash: npm install\n- bash: npm test",
    "steps:\n- task: NodeTool@0\n  inputs:\n    versionSpec: '18.x'\n\n- bash: npm install\n\n- bash: npm test"
);

runTest(
    'Multiline bash followed by regular step has blank line',
    'steps:\n- bash: |\n    echo "Multi-line"\n    echo "script"\n  displayName: Run Script\n- bash: echo "Next step"',
    'steps:\n- bash: |\n    echo "Multi-line"\n    echo "script"\n  displayName: Run Script\n\n- bash: echo "Next step"'
);

runTest(
    'Elseif control structure has blank line as sibling',
    'steps:\n- task: Setup@1\n- ${{ if eq(parameters.mode, \'build\') }}:\n  - bash: echo "Building"\n- ${{ elseif eq(parameters.mode, \'test\') }}:\n  - bash: echo "Testing"\n- bash: echo "Done"',
    'steps:\n- task: Setup@1\n\n- ${{ if eq(parameters.mode, \'build\') }}:\n  - bash: echo "Building"\n\n- ${{ elseif eq(parameters.mode, \'test\') }}:\n  - bash: echo "Testing"\n\n- bash: echo "Done"'
);

// ============================================================
// SECTION 4: Variables Section Tests (No Unwanted Blanks)
// ============================================================
console.log('\n📍 Variables Section Tests (Preventing Unwanted Blanks)');

runTest(
    'Variables with conditional directives have no blanks inside',
    "variables:\n- name: BaseVersion\n  value: 1.0.0\n- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:\n  - name: ReleaseVersion\n    value: 1.0.0-release\n- name: BuildOutputPath\n  value: $(Build.ArtifactStagingDirectory)",
    "variables:\n- name: BaseVersion\n  value: 1.0.0\n- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:\n  - name: ReleaseVersion\n    value: 1.0.0-release\n- name: BuildOutputPath\n  value: $(Build.ArtifactStagingDirectory)"
);

runTest(
    'Simple variables list has no blanks between items',
    'variables:\n- name: MajorVersion\n  value: 1\n- name: MinorVersion\n  value: 0\n- name: PatchVersion\n  value: 5\n- name: FullVersion\n  value: $(MajorVersion).$(MinorVersion).$(PatchVersion)',
    'variables:\n- name: MajorVersion\n  value: 1\n- name: MinorVersion\n  value: 0\n- name: PatchVersion\n  value: 5\n- name: FullVersion\n  value: $(MajorVersion).$(MinorVersion).$(PatchVersion)'
);

runTest(
    'Variables with group references have no blanks',
    'variables:\n- group: ProductionSecrets\n- name: BuildConfiguration\n  value: Release\n- name: Environment\n  value: Production\n- group: StagingSecrets',
    'variables:\n- group: ProductionSecrets\n- name: BuildConfiguration\n  value: Release\n- name: Environment\n  value: Production\n- group: StagingSecrets'
);

runTest(
    'Variables with complex multi-line values have no blanks',
    'variables:\n- name: ConfigPath\n  value: |\n    /config/app.json\n    /config/db.json\n- name: BuildScript\n  value: |\n    npm install\n    npm run build\n- name: TestScript\n  value: npm test',
    'variables:\n- name: ConfigPath\n  value: |\n    /config/app.json\n    /config/db.json\n- name: BuildScript\n  value: |\n    npm install\n    npm run build\n- name: TestScript\n  value: npm test'
);

// ============================================================
// SECTION 4b: Parameters Section Tests (No Unwanted Blanks)
// ============================================================
console.log('\n📍 Parameters Section Tests (Preventing Unwanted Blanks)');

runTest(
    'Parameters with nested mappings have no blanks between items',
    'parameters:\n- name: param1\n  type: string\n  default: value1\n- name: param2\n  type: string\n  displayName: Parameter 2\n  default: value2\n- name: param3\n  type: string\n  default: value3',
    'parameters:\n- name: param1\n  type: string\n  default: value1\n- name: param2\n  type: string\n  displayName: Parameter 2\n  default: value2\n- name: param3\n  type: string\n  default: value3'
);

runTest(
    'Parameters with different types have no blanks',
    'parameters:\n- name: buildConfig\n  type: string\n  default: Debug\n- name: enableTests\n  type: boolean\n  default: true\n- name: timeoutMinutes\n  type: number\n  default: 30',
    'parameters:\n- name: buildConfig\n  type: string\n  default: Debug\n- name: enableTests\n  type: boolean\n  default: true\n- name: timeoutMinutes\n  type: number\n  default: 30'
);

runTest(
    'Parameters with values (dropdown options) have no blanks',
    'parameters:\n- name: environment\n  type: string\n  default: dev\n  values:\n  - dev\n  - staging\n  - production\n- name: region\n  type: string\n  default: us-east\n  values:\n  - us-east\n  - us-west\n  - eu-west',
    'parameters:\n- name: environment\n  type: string\n  default: dev\n  values:\n  - dev\n  - staging\n  - production\n- name: region\n  type: string\n  default: us-east\n  values:\n  - us-east\n  - us-west\n  - eu-west'
);

runTest(
    'Parameters with object type defaults have no blanks',
    'parameters:\n- name: poolConfig\n  type: object\n  default:\n    vmImage: ubuntu-latest\n    demands:\n    - agent.os -equals Linux\n- name: imageConfig\n  type: object\n  default:\n    registry: myregistry\n    image: myimage:latest',
    'parameters:\n- name: poolConfig\n  type: object\n  default:\n    vmImage: ubuntu-latest\n    demands:\n    - agent.os -equals Linux\n- name: imageConfig\n  type: object\n  default:\n    registry: myregistry\n    image: myimage:latest'
);

runTest(
    'Parameters with conditions have no blanks inside block',
    "parameters:\n- name: solution\n  type: string\n  default: MySolution.sln\n- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:\n  - name: releaseVersion\n    type: string\n    default: '1.0.0'\n- name: buildConfiguration\n  type: string\n  default: Release",
    "parameters:\n- name: solution\n  type: string\n  default: MySolution.sln\n- ${{ if eq(variables['Build.SourceBranch'], 'refs/heads/main') }}:\n  - name: releaseVersion\n    type: string\n    default: '1.0.0'\n- name: buildConfiguration\n  type: string\n  default: Release"
);

runTest(
    'Parameters with all properties have no blanks',
    'parameters:\n- name: buildTarget\n  displayName: Build Target\n  type: string\n  default: Release\n  values:\n  - Debug\n  - Release\n- name: skipTests\n  displayName: Skip Unit Tests\n  type: boolean\n  default: false\n- name: buildNumber\n  displayName: Build Number\n  type: number\n  default: 1',
    'parameters:\n- name: buildTarget\n  displayName: Build Target\n  type: string\n  default: Release\n  values:\n  - Debug\n  - Release\n- name: skipTests\n  displayName: Skip Unit Tests\n  type: boolean\n  default: false\n- name: buildNumber\n  displayName: Build Number\n  type: number\n  default: 1'
);

// ============================================================
// SECTION 5: Nested Section Tests (dependsOn, etc.)
// ============================================================
console.log('\n📍 Nested Section Tests (No Blanks in Nested Lists)');

runTest(
    'dependsOn list items (nested mapping) have no blanks between siblings',
    'jobs:\n- job: BuildJob\n  steps:\n  - script: echo Build\n- job: TestJob\n  dependsOn:\n  - BuildJob\n  - OtherJob\n  - ThirdJob\n  steps:\n  - bash: echo "Running tests"',
    'jobs:\n- job: BuildJob\n  steps:\n  - script: echo Build\n\n- job: TestJob\n  dependsOn:\n  - BuildJob\n  - OtherJob\n  - ThirdJob\n\n  steps:\n  - bash: echo "Running tests"'
);

// ============================================================
// SECTION 6: Blank Preservation in Main Sections
// ============================================================
console.log('\n📍 Blank Preservation in Main Sections (Steps)');

runTest(
    'Blanks between steps are preserved (create-report-v0 scenario)',
    'steps:\n- task: PublishPipelineArtifact@1\n  inputs:\n    PathtoPublish: readme.txt\n    ArtifactName: StatusLogs\n- task: DownloadPipelineArtifact@2\n  inputs:\n    artifact: StatusLogs\n    targetPath: StatusLogs\n- bash: |\n    if [ "${SYSTEM_DEBUG@L}" == "true" ]; then\n      set -x\n    fi\n    echo "Generating build status report..."',
    'steps:\n- task: PublishPipelineArtifact@1\n  inputs:\n    PathtoPublish: readme.txt\n    ArtifactName: StatusLogs\n\n- task: DownloadPipelineArtifact@2\n  inputs:\n    artifact: StatusLogs\n    targetPath: StatusLogs\n\n- bash: |\n    if [ "${SYSTEM_DEBUG@L}" == "true" ]; then\n      set -x\n    fi\n    echo "Generating build status report..."'
);

runTest(
    'Blanks preserved between tasks in steps section',
    'steps:\n- task: UseDotNet@2\n  inputs:\n    version: 8.0.x\n  displayName: Install .NET 8\n- task: DotNetCoreCLI@2\n  inputs:\n    command: restore\n  displayName: Restore packages\n- task: DotNetCoreCLI@2\n  inputs:\n    command: build\n  displayName: Build solution',
    'steps:\n- task: UseDotNet@2\n  inputs:\n    version: 8.0.x\n  displayName: Install .NET 8\n\n- task: DotNetCoreCLI@2\n  inputs:\n    command: restore\n  displayName: Restore packages\n\n- task: DotNetCoreCLI@2\n  inputs:\n    command: build\n  displayName: Build solution'
);

runTest(
    'Blanks preserved with complex nested task properties',
    'steps:\n- task: Bash@3\n  env:\n    REPORTS_FILE: $(parameters.reportsFile)\n    SYSTEM_ACCESSTOKEN: $(System.AccessToken)\n  inputs:\n    targetType: inline\n    script: |\n      python3 - <<\'PYEOF\'\n      import os\n      print("Processing reports")\n      PYEOF\n- bash: echo "Complete"',
    'steps:\n- task: Bash@3\n  env:\n    REPORTS_FILE: $(parameters.reportsFile)\n    SYSTEM_ACCESSTOKEN: $(System.AccessToken)\n  inputs:\n    targetType: inline\n    script: |\n      python3 - <<\'PYEOF\'\n      import os\n      print("Processing reports")\n      PYEOF\n\n- bash: echo "Complete"'
);

// ============================================================
// Summary
// ============================================================
console.log('\n' + '='.repeat(60));
console.log('Tests passed: ' + passedTests + '/' + totalTests);

if (passedTests === totalTests) {
    console.log('✅ All comprehensive spacing tests passed!');
    process.exit(0);
} else {
    console.log('❌ ' + (totalTests - passedTests) + ' test(s) failed');
    process.exit(1);
}

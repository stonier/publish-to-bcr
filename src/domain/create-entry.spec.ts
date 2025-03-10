import { createTwoFilesPatch } from "diff";
import { Mocked, mocked } from "jest-mock";
import { randomUUID } from "node:crypto";
import fs, { PathLike } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitClient } from "../infrastructure/git";
import { GitHubClient } from "../infrastructure/github";
import {
  fakeMetadataFile,
  fakeModuleFile,
  fakePresubmitFile,
  fakeSourceFile,
} from "../test/mock-template-files";
import { expectThrownError } from "../test/util";
import {
  CreateEntryService,
  PatchModuleError,
  VersionAlreadyPublishedError,
} from "./create-entry";
import { CANONICAL_BCR } from "./find-registry-fork";
import { computeIntegrityHash } from "./integrity-hash";
import { MetadataFileError } from "./metadata-file";
import { ModuleFile } from "./module-file";
import { ReleaseArchive } from "./release-archive";
import { Repository } from "./repository";
import { RulesetRepository } from "./ruleset-repository";
import { User } from "./user";

let createEntryService: CreateEntryService;
let mockGitClient: Mocked<GitClient>;
let mockGithubClient: Mocked<GitHubClient>;

jest.mock("../infrastructure/git");
jest.mock("../infrastructure/github");
jest.mock("./integrity-hash");
jest.mock("./release-archive");
jest.mock("node:fs");

const mockedFileReads: { [path: string]: string } = {};
const EXTRACTED_MODULE_PATH = "/fake/path/to/MODULE.bazel";

beforeEach(() => {
  jest.clearAllMocks();

  mocked(fs.readFileSync).mockImplementation(((
    path: string,
    ...args: any[]
  ) => {
    if (path in mockedFileReads) {
      return mockedFileReads[path];
    }
    return (jest.requireActual("node:fs") as any).readFileSync.apply([
      path,
      ...args,
    ]);
  }) as any);

  mocked(fs.readdirSync).mockImplementation(((p: PathLike, options: any) => {
    return Object.keys(mockedFileReads)
      .filter((f) => path.dirname(f) === p)
      .map((f) => path.basename(f));
  }) as any);

  mocked(fs.existsSync).mockImplementation(((p: string) => {
    if (p in mockedFileReads) {
      return true;
    }
    for (const f of Object.keys(mockedFileReads)) {
      if (path.dirname(f) == p) {
        return true;
      }
    }
    return (jest.requireActual("node:fs") as any).existsSync(path);
  }) as any);

  for (let key of Object.keys(mockedFileReads)) {
    delete mockedFileReads[key];
  }

  mocked(ReleaseArchive.fetch).mockImplementation(async () => {
    return {
      extractModuleFile: jest.fn(async () => {
        return new ModuleFile(EXTRACTED_MODULE_PATH);
      }),
      diskPath: path.join(os.tmpdir(), "archive.tar.gz"),
    } as unknown as ReleaseArchive;
  });

  mockGitClient = mocked(new GitClient());
  mockGithubClient = mocked(new GitHubClient());
  mocked(computeIntegrityHash).mockReturnValue(`sha256-${randomUUID()}`);
  Repository.gitClient = mockGitClient;
  createEntryService = new CreateEntryService(mockGitClient, mockGithubClient);
});

describe("createEntryFiles", () => {
  test("checks out the ruleset repository at the release tag", async () => {
    mockRulesetFiles();
    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

    expect(mockGitClient.checkout).toHaveBeenCalledWith(
      rulesetRepo.diskPath,
      tag
    );
  });

  test("checks out the bcr repo at main", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

    expect(mockGitClient.checkout).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      "main"
    );
  });

  test("creates the required entry files", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

    const metadataFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "metadata.json"
    );
    const sourceFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "1.2.3",
      "source.json"
    );
    const presubmitFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "1.2.3",
      "presubmit.yml"
    );
    const moduleFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "1.2.3",
      "MODULE.bazel"
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      metadataFilePath,
      expect.any(String)
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      moduleFilePath,
      expect.any(String)
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      sourceFilePath,
      expect.any(String)
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      expect.any(String),
      presubmitFilePath
    );
  });

  test("creates the required entry files for a different module root", async () => {
    mockRulesetFiles({
      moduleRoot: "sub/dir",
    });

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(
      rulesetRepo,
      bcrRepo,
      tag,
      "sub/dir"
    );

    const metadataFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "metadata.json"
    );
    const sourceFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "1.2.3",
      "source.json"
    );
    const presubmitFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "1.2.3",
      "presubmit.yml"
    );
    const moduleFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "fake_ruleset",
      "1.2.3",
      "MODULE.bazel"
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      metadataFilePath,
      expect.any(String)
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      moduleFilePath,
      expect.any(String)
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      sourceFilePath,
      expect.any(String)
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      expect.any(String),
      presubmitFilePath
    );
  });

  test("throws when an entry for the version already exists", async () => {
    mockRulesetFiles();

    const tag = "v1.0.0";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", true);
    mockBcrMetadataFile(rulesetRepo, bcrRepo, "fake_ruleset", {
      versions: ["1.0.0"],
    });

    const thrownError = await expectThrownError(
      () => createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, "."),
      VersionAlreadyPublishedError
    );
    expect(thrownError!.message.includes("1.0.0")).toEqual(true);
  });

  describe("metadata.json", () => {
    test("creates a new metadata file if one doesn't exist for the ruleset", async () => {
      mockRulesetFiles();

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", false);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeMetadataCall = mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes("metadata.json")
      );
      const writtenMetadataContent = writeMetadataCall[1] as string;
      expect(JSON.parse(fakeMetadataFile({ versions: ["1.2.3"] }))).toEqual(
        JSON.parse(writtenMetadataContent)
      );
    });

    test("adds versions from existing bcr metadata file if one exists", async () => {
      mockRulesetFiles();

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", true);
      mockBcrMetadataFile(rulesetRepo, bcrRepo, "fake_ruleset", {
        versions: ["1.0.0", "1.1.0"],
      });

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeMetadataCall = mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes("metadata.json")
      );
      const writtenMetadataContent = writeMetadataCall[1] as string;
      expect(
        JSON.parse(fakeMetadataFile({ versions: ["1.0.0", "1.1.0", "1.2.3"] }))
      ).toEqual(JSON.parse(writtenMetadataContent));
    });

    test("does not include versions in the template metadata file", async () => {
      // ...because the canonical released versions comes from the BCR
      mockRulesetFiles({ metadataVersions: ["0.0.1"] });

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", true);
      mockBcrMetadataFile(rulesetRepo, bcrRepo, "fake_ruleset", {
        versions: ["1.0.0"],
      });

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeMetadataCall = mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes("metadata.json")
      );
      const writtenMetadataContent = writeMetadataCall[1] as string;
      expect(
        JSON.parse(fakeMetadataFile({ versions: ["1.0.0", "1.2.3"] })) // doesn't have 0.0.1
      ).toEqual(JSON.parse(writtenMetadataContent));
    });

    test("updates bcr metadata file if there were changes to the template", async () => {
      mockRulesetFiles({ metadataHomepage: "foo.bar.com" });

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", true);
      mockBcrMetadataFile(rulesetRepo, bcrRepo, "fake_ruleset");

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeMetadataCall = mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes("metadata.json")
      );
      const writtenMetadataContent = writeMetadataCall[1] as string;
      expect(JSON.parse(writtenMetadataContent)).toEqual(
        JSON.parse(
          fakeMetadataFile({ versions: ["1.2.3"], homepage: "foo.bar.com" })
        )
      );
    });

    test("creates a new metadata file when the tag doens't start with a 'v'", async () => {
      mockRulesetFiles();

      const tag = "1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", false);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeMetadataCall = mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes("metadata.json")
      );
      const writtenMetadataContent = writeMetadataCall[1] as string;
      expect(JSON.parse(fakeMetadataFile({ versions: ["1.2.3"] }))).toEqual(
        JSON.parse(writtenMetadataContent)
      );
    });

    test("complains when the bcr metadata file cannot be parsed", async () => {
      mockRulesetFiles();

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", true);
      mockBcrMetadataFile(rulesetRepo, bcrRepo, "fake_ruleset", {
        malformed: true,
      });

      await expectThrownError(
        () =>
          createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, "."),
        MetadataFileError
      );
    });

    test("does not un-yank yanked versions in the bcr", async () => {
      mockRulesetFiles({
        metadataVersions: ["1.0.0"],
        metadataYankedVersions: {},
      });

      const tag = "v2.0.0";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      mockBcrMetadataExists(rulesetRepo, bcrRepo, "fake_ruleset", true);
      mockBcrMetadataFile(rulesetRepo, bcrRepo, "fake_ruleset", {
        versions: ["1.0.0"],
        yankedVersions: { "1.0.0": "has a bug" },
      });

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeMetadataCall = mocked(fs.writeFileSync).mock.calls.find(
        (call) => (call[0] as string).includes("metadata.json")
      );
      const writtenMetadataContent = writeMetadataCall[1] as string;

      expect(JSON.parse(writtenMetadataContent).yanked_versions).toEqual({
        "1.0.0": "has a bug",
      });
    });
  });

  describe("MODULE.bazel", () => {
    test("uses the archived module file", async () => {
      mockRulesetFiles({
        extractedModuleName: "rules_bar",
        extractedModuleVersion: "1.2.3",
      });

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeModuleCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("MODULE.bazel")
      );
      const writtenModuleContent = writeModuleCall[1] as string;
      expect(writtenModuleContent).toEqual(
        fakeModuleFile({ moduleName: "rules_bar", version: "1.2.3" })
      );
    });

    test("overrides the release version when it does not match the archived version", async () => {
      mockRulesetFiles({
        extractedModuleName: "rules_bar",
        extractedModuleVersion: "1.2.3",
      });

      const tag = "v4.5.6";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeModuleCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("MODULE.bazel")
      );
      const writtenModuleContent = writeModuleCall[1] as string;
      expect(writtenModuleContent).toEqual(
        fakeModuleFile({ moduleName: "rules_bar", version: "4.5.6" })
      );
    });
  });

  describe("presubmit.yml", () => {
    test("copies the presubmit.yml file", async () => {
      mockRulesetFiles({ extractedModuleName: "foo_ruleset" });

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      expect(fs.copyFileSync).toHaveBeenCalledWith(
        rulesetRepo.presubmitPath("."),
        path.join(
          bcrRepo.diskPath,
          "modules",
          "foo_ruleset",
          "1.2.3",
          "presubmit.yml"
        )
      );
    });
  });

  describe("source.json", () => {
    test("stamps an integrity hash", async () => {
      mockRulesetFiles();

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      const hash = `sha256-${randomUUID()}`;
      mocked(computeIntegrityHash).mockReturnValue(hash);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("source.json")
      );
      const writtenSourceContent = JSON.parse(writeSourceCall[1] as string);
      expect(writtenSourceContent.integrity).toEqual(hash);
    });

    test("substitutes values for {REPO}, {OWNER}, {VERSION}, and {TAG}", async () => {
      mockRulesetFiles({
        sourceUrl:
          "https://github.com/{OWNER}/{REPO}/archive/refs/tags/{TAG}.tar.gz",
        sourceStripPrefix: "{REPO}-{VERSION}",
      });

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("source.json")
      );
      const writtenSourceContent = JSON.parse(writeSourceCall[1] as string);
      expect(writtenSourceContent.url).toEqual(
        `https://github.com/${rulesetRepo.owner}/${rulesetRepo.name}/archive/refs/tags/${tag}.tar.gz`
      );
      expect(writtenSourceContent.strip_prefix).toEqual(
        `${rulesetRepo.name}-1.2.3`
      );
    });

    test("saves with a trailing newline", async () => {
      mockRulesetFiles();

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      const hash = `sha256-${randomUUID()}`;
      mocked(computeIntegrityHash).mockReturnValue(hash);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("source.json")
      );
      const writtenSourceContent = writeSourceCall[1] as string;
      expect(writtenSourceContent.endsWith("\n")).toEqual(true);
    });

    test("adds a patch entry when the release version does not match the archived version", async () => {
      mockRulesetFiles({
        extractedModuleName: "rules_bar",
        extractedModuleVersion: "1.2.3",
      });

      const tag = "v4.5.6";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      const hash = `sha256-${randomUUID()}`;
      mocked(computeIntegrityHash).mockReturnValue(hash);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("source.json")
      );
      const writtenSourceContent = JSON.parse(writeSourceCall[1] as string);
      expect(
        writtenSourceContent.patches["module_dot_bazel_version.patch"]
      ).toEqual(hash);
    });

    test("sets the patch_strip to 1 when a release version patch is added", async () => {
      mockRulesetFiles({
        extractedModuleName: "rules_bar",
        extractedModuleVersion: "1.2.3",
      });

      const tag = "v4.5.6";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      const hash = `sha256-${randomUUID()}`;
      mocked(computeIntegrityHash).mockReturnValue(hash);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("source.json")
      );
      const writtenSourceContent = JSON.parse(writeSourceCall[1] as string);
      expect(writtenSourceContent.patch_strip).toEqual(1);
    });

    test("adds a patch entry for each patch in the patches folder", async () => {
      mockRulesetFiles({
        extractedModuleName: "rules_bar",
        extractedModuleVersion: "1.2.3",
        patches: {
          "patch1.patch": randomUUID(),
          "patch2.patch": randomUUID(),
        },
      });

      const tag = "v1.2.3";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      const hash1 = `sha256-${randomUUID()}`;
      const hash2 = `sha256-${randomUUID()}`;

      mocked(computeIntegrityHash).mockReturnValueOnce(
        `sha256-${randomUUID()}`
      ); // release archive
      mocked(computeIntegrityHash).mockReturnValueOnce(hash1);
      mocked(computeIntegrityHash).mockReturnValueOnce(hash2);

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("source.json")
      );
      const writtenSourceContent = JSON.parse(writeSourceCall[1] as string);
      expect(writtenSourceContent.patches["patch1.patch"]).toEqual(hash1);
      expect(writtenSourceContent.patches["patch2.patch"]).toEqual(hash2);
    });
  });

  test("sets the patch_strip to 1 when a patch is added", async () => {
    mockRulesetFiles({
      extractedModuleName: "rules_bar",
      extractedModuleVersion: "1.2.3",
      patches: {
        "patch.patch": randomUUID(),
      },
    });

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    const hash = `sha256-${randomUUID()}`;
    mocked(computeIntegrityHash).mockReturnValueOnce(`sha256-${randomUUID()}`); // release archive
    mocked(computeIntegrityHash).mockReturnValueOnce(hash);

    await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

    const writeSourceCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
      (call[0] as string).includes("source.json")
    );
    const writtenSourceContent = JSON.parse(writeSourceCall[1] as string);
    expect(writtenSourceContent.patch_strip).toEqual(1);
  });

  describe("patches", () => {
    test("creates a patch file when the release version does not match the archived version", async () => {
      mockRulesetFiles({
        extractedModuleName: "rules_bar",
        extractedModuleVersion: "1.2.3",
      });

      const tag = "v4.5.6";
      const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
      const bcrRepo = CANONICAL_BCR;

      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

      const expectedPatchPath = path.join(
        bcrRepo.diskPath,
        "modules",
        "rules_bar",
        "4.5.6",
        "patches",
        "module_dot_bazel_version.patch"
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expectedPatchPath,
        expect.any(String)
      );
      const writePatchCall = mocked(fs.writeFileSync).mock.calls.find((call) =>
        (call[0] as string).includes("module_dot_bazel_version.patch")
      );
      const writtenPatchContent = writePatchCall[1] as string;
      expect(
        writtenPatchContent.includes(`\
--- a/MODULE.bazel
+++ b/MODULE.bazel
@@ -1,5 +1,5 @@
 module(
   name = "rules_bar",
   compatibility_level = 1,
-  version = "1.2.3",
+  version = "4.5.6",
 )`)
      ).toEqual(true);
    });
  });

  test("includes patches in the patches folder", async () => {
    mockRulesetFiles({
      extractedModuleName: "rules_bar",
      extractedModuleVersion: "1.2.3",
      patches: {
        "my_patch.patch": randomUUID(),
      },
    });

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

    const expectedPatchPath = path.join(
      bcrRepo.diskPath,
      "modules",
      "rules_bar",
      "1.2.3",
      "patches",
      "my_patch.patch"
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      path.join(rulesetRepo.patchesPath("."), "my_patch.patch"),
      expectedPatchPath
    );
  });

  test("includes patches in a different module root", async () => {
    mockRulesetFiles({
      extractedModuleName: "rules_bar",
      extractedModuleVersion: "1.2.3",
      patches: {
        "submodule.patch": randomUUID(),
      },
      moduleRoot: "submodule",
    });

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(
      rulesetRepo,
      bcrRepo,
      tag,
      "submodule"
    );

    const expectedPatchPath = path.join(
      bcrRepo.diskPath,
      "modules",
      "rules_bar",
      "1.2.3",
      "patches",
      "submodule.patch"
    );
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      path.join(rulesetRepo.patchesPath("submodule"), "submodule.patch"),
      expectedPatchPath
    );
  });

  test("applies a patch to the entry's MODULE.bazel file", async () => {
    const extractedModule = fakeModuleFile({
      version: "1.2.3",
      moduleName: "rules_bar",
      deps: false,
    });

    const exptectedPatchedModule = fakeModuleFile({
      version: "1.2.3",
      moduleName: "rules_bar",
      deps: true,
    });

    const patch = createTwoFilesPatch(
      "a/MODULE.bazel",
      "b/MODULE.bazel",
      extractedModule,
      exptectedPatchedModule
    );

    mockRulesetFiles({
      extractedModuleContent: extractedModule,
      patches: {
        "patch_deps.patch": patch,
      },
    });

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");

    const moduleFilePath = path.join(
      bcrRepo.diskPath,
      "modules",
      "rules_bar",
      "1.2.3",
      "MODULE.bazel"
    );

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      moduleFilePath,
      exptectedPatchedModule
    );
  });

  test("throws when a patch that alters MODULE.bazel cannot be applied", async () => {
    const patchFrom = fakeModuleFile({
      version: "1.0.0",
      moduleName: "rules_bar",
      deps: false,
    });

    const patchTo = fakeModuleFile({
      version: "1.2.3",
      moduleName: "rules_bar",
      deps: true,
    });

    const badPatch = createTwoFilesPatch(
      "a/MODULE.bazel",
      "b/MODULE.bazel",
      patchFrom,
      patchTo
    );

    mockRulesetFiles({
      // Different from the patch origin
      extractedModuleContent: fakeModuleFile({
        version: "1.2.3",
        moduleName: "rules_bar",
        deps: false,
      }),
      patches: {
        "patch_deps.patch": badPatch,
      },
    });

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;

    let caughtError: any;
    try {
      await createEntryService.createEntryFiles(rulesetRepo, bcrRepo, tag, ".");
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError instanceof PatchModuleError);
    const patchPath = path.join(
      rulesetRepo.diskPath,
      RulesetRepository.BCR_TEMPLATE_DIR,
      "patches",
      "patch_deps.patch"
    );
    expect((caughtError as Error).message).toEqual(
      expect.stringContaining(patchPath)
    );
  });
});

describe("commitEntryToNewBranch", () => {
  test("sets the commit author to the releaser", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;
    const releaser: User = {
      name: "Json Bearded",
      email: "json@bearded.ca",
      username: "json",
    };

    await createEntryService.commitEntryToNewBranch(
      rulesetRepo,
      bcrRepo,
      tag,
      releaser
    );

    expect(mockGitClient.setUserNameAndEmail).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      releaser.name,
      releaser.email
    );
  });

  test("checks out a new branch on the bcr repo", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;
    const releaser: User = {
      name: "Json Bearded",
      email: "json@bearded.ca",
      username: "json",
    };

    await createEntryService.commitEntryToNewBranch(
      rulesetRepo,
      bcrRepo,
      tag,
      releaser
    );

    expect(mockGitClient.checkoutNewBranchFromHead).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      expect.any(String)
    );
  });

  test("branch contains the repo name and release tag", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;
    const releaser: User = {
      name: "Json Bearded",
      email: "json@bearded.ca",
      username: "json",
    };

    await createEntryService.commitEntryToNewBranch(
      rulesetRepo,
      bcrRepo,
      tag,
      releaser
    );

    expect(mockGitClient.checkoutNewBranchFromHead).toHaveBeenCalledTimes(1);
    expect(mockGitClient.checkoutNewBranchFromHead).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(rulesetRepo.canonicalName)
    );
    expect(mockGitClient.checkoutNewBranchFromHead).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(tag)
    );
  });

  test("returns the created branch name", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;
    const releaser: User = {
      name: "Json Bearded",
      email: "json@bearded.ca",
      username: "json",
    };

    const returnedBranch = await createEntryService.commitEntryToNewBranch(
      rulesetRepo,
      bcrRepo,
      tag,
      releaser
    );
    const createdBranch =
      mockGitClient.checkoutNewBranchFromHead.mock.calls[0][1];

    expect(returnedBranch).toEqual(createdBranch);
  });

  test("commit message contains the repo name and release tag", async () => {
    mockRulesetFiles();

    const tag = "v1.2.3";
    const rulesetRepo = await RulesetRepository.create("repo", "owner", tag);
    const bcrRepo = CANONICAL_BCR;
    const releaser: User = {
      name: "Json Bearded",
      email: "json@bearded.ca",
      username: "json",
    };

    await createEntryService.commitEntryToNewBranch(
      rulesetRepo,
      bcrRepo,
      tag,
      releaser
    );

    expect(mockGitClient.commitChanges).toHaveBeenCalledTimes(1);
    expect(mockGitClient.commitChanges).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      expect.stringContaining(rulesetRepo.canonicalName)
    );
    expect(mockGitClient.commitChanges).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      expect.stringContaining(tag)
    );
  });
});

describe("pushEntryToFork", () => {
  test("acquires an authenticated remote url for the bcr fork", async () => {
    const bcrRepo = CANONICAL_BCR;
    const bcrForkRepo = new Repository("bazel-central-registry", "aspect");
    const branchName = `repo/owner@v1.2.3`;

    await createEntryService.pushEntryToFork(bcrForkRepo, bcrRepo, branchName);
    expect(mockGithubClient.getAuthenticatedRemoteUrl).toHaveBeenCalledWith(
      bcrForkRepo
    );
  });

  test("adds a remote with the authenticated url for the fork to the local bcr repo", async () => {
    const bcrRepo = CANONICAL_BCR;
    const bcrForkRepo = new Repository("bazel-central-registry", "aspect");
    const branchName = `repo/owner@v1.2.3`;
    const authenticatedUrl = randomUUID();

    mockGithubClient.getAuthenticatedRemoteUrl.mockReturnValueOnce(
      Promise.resolve(authenticatedUrl)
    );

    await createEntryService.pushEntryToFork(bcrForkRepo, bcrRepo, branchName);
    expect(mockGitClient.addRemote).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      expect.any(String),
      authenticatedUrl
    );
  });

  test("named the authenticated remote 'authed-fork'", async () => {
    const bcrRepo = CANONICAL_BCR;
    const bcrForkRepo = new Repository("bazel-central-registry", "aspect");
    const branchName = `repo/owner@v1.2.3`;
    const authenticatedUrl = randomUUID();

    mockGithubClient.getAuthenticatedRemoteUrl.mockReturnValueOnce(
      Promise.resolve(authenticatedUrl)
    );

    await createEntryService.pushEntryToFork(bcrForkRepo, bcrRepo, branchName);
    expect(mockGitClient.addRemote).toHaveBeenCalledWith(
      expect.any(String),
      "authed-fork",
      expect.any(String)
    );
  });

  test("does not re-add the remote if it already exists", async () => {
    const bcrRepo = CANONICAL_BCR;
    const bcrForkRepo = new Repository("bazel-central-registry", "aspect");
    const branchName = `repo/owner@v1.2.3`;
    const authenticatedUrl = randomUUID();

    mockGitClient.hasRemote.mockReturnValueOnce(Promise.resolve(true));
    mockGithubClient.getAuthenticatedRemoteUrl.mockReturnValueOnce(
      Promise.resolve(authenticatedUrl)
    );

    await createEntryService.pushEntryToFork(bcrForkRepo, bcrRepo, branchName);
    expect(mockGitClient.addRemote).not.toHaveBeenCalled();
  });

  test("pushes the entry branch to the fork using the authorized remote", async () => {
    const bcrRepo = CANONICAL_BCR;
    const bcrForkRepo = new Repository("bazel-central-registry", "aspect");
    const branchName = `repo/owner@v1.2.3`;

    await createEntryService.pushEntryToFork(bcrForkRepo, bcrRepo, branchName);

    expect(mockGitClient.push).toHaveBeenCalledWith(
      bcrRepo.diskPath,
      "authed-fork",
      branchName
    );
  });
});

function mockRulesetFiles(
  options: {
    extractedModuleContent?: string;
    extractedModuleName?: string;
    extractedModuleVersion?: string;
    metadataHomepage?: string;
    metadataVersions?: string[];
    metadataYankedVersions?: { [version: string]: string };
    sourceUrl?: string;
    sourceStripPrefix?: string;
    moduleRoot?: string;
    patches?: { [path: string]: string };
  } = {}
) {
  mockGitClient.checkout.mockImplementation(
    async (repoPath: string, ref?: string) => {
      const moduleRoot = options?.moduleRoot || ".";
      if (options.extractedModuleContent) {
        mockedFileReads[EXTRACTED_MODULE_PATH] = options.extractedModuleContent;
      } else {
        mockedFileReads[EXTRACTED_MODULE_PATH] = fakeModuleFile({
          version: options.extractedModuleVersion || "1.2.3",
          moduleName: options.extractedModuleName,
        });
      }
      const templatesDir = path.join(
        repoPath,
        RulesetRepository.BCR_TEMPLATE_DIR
      );
      mockedFileReads[
        path.join(templatesDir, "config.yml")
      ] = `moduleRoots: ["${moduleRoot}"]`;
      mockedFileReads[
        path.join(templatesDir, moduleRoot, "source.template.json")
      ] = fakeSourceFile({
        url: options.sourceUrl,
        stripPrefix: options.sourceStripPrefix,
      });
      mockedFileReads[path.join(templatesDir, moduleRoot, "presubmit.yml")] =
        fakePresubmitFile();
      mockedFileReads[
        path.join(templatesDir, moduleRoot, "metadata.template.json")
      ] = fakeMetadataFile({
        versions: options.metadataVersions,
        yankedVersions: options.metadataYankedVersions,
        homepage: options.metadataHomepage,
      });
      if (options.patches) {
        for (const patch of Object.keys(options.patches)) {
          mockedFileReads[
            path.join(templatesDir, moduleRoot, "patches", patch)
          ] = options.patches[patch];
        }
      }
    }
  );
}

function mockBcrMetadataExists(
  rulesetRepo: RulesetRepository,
  bcrRepo: Repository,
  moduleName: string,
  exists: boolean
) {
  mocked(fs.existsSync).mockImplementation(((p: string) => {
    if (
      p == path.join(bcrRepo.diskPath, "modules", moduleName, "metadata.json")
    ) {
      return exists;
    }
    return (jest.requireActual("node:fs") as any).existsSync(path);
  }) as any);
}

function mockBcrMetadataFile(
  rulesetRepo: RulesetRepository,
  bcrRepo: Repository,
  moduleName: string,
  options?: {
    versions?: string[];
    yankedVersions?: { [version: string]: string };
    homepage?: string;
    malformed?: boolean;
  }
) {
  mockedFileReads[
    path.join(bcrRepo.diskPath, "modules", moduleName, "metadata.json")
  ] = fakeMetadataFile(options);
}

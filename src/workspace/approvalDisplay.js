function shortSha(value) {
  return String(value || "").slice(0, 12);
}

function formatBoundApproval(display) {
  if (!display) return "No bound approval was found.";
  const summary = display.summary || {};
  const paths = display.changedPaths.length > 0
    ? display.changedPaths.map((filePath) => `- \`${filePath}\``).join("\n")
    : "- (none)";
  const risks = display.riskSignals.length > 0 ? display.riskSignals.join(", ") : "NONE";
  const actors = display.allowedActorIds.join(", ") || "NONE";
  const refs = display.allowedTargetRefs.join(", ") || "NONE";
  return [
    `🔐 **Bound approval #${display.approvalId}** — \`${display.status}\``,
    `- task: \`${display.taskId}\``,
    `- artifact: \`${display.artifactId}\``,
    `- base → candidate: \`${shortSha(display.baseCommitSha)}\` → \`${shortSha(display.candidateCommitSha)}\``,
    `- artifact hash: \`${display.artifactHash}\``,
    `- context hash: \`${display.contextManifestHash}\``,
    `- diff hash: \`${display.diffHash}\``,
    `- diff size: ${summary.changedFileCount || 0} files, +${summary.additions || 0}/-${summary.deletions || 0}, ${summary.binaryFiles || 0} binary, ${summary.deletedFiles || 0} deleted`,
    `- risk: \`${risks}\``,
    `- expected task: \`${display.expectedTaskState}@${display.expectedTaskVersion}\``,
    `- expires: \`${new Date(display.expiresAt).toISOString()}\``,
    `- delegated finalizer(s): \`${actors}\``,
    `- allowed ref(s): \`${refs}\``,
    "- changed paths:",
    paths,
    "",
    `승인: \`!approve ${display.approvalId}\`  |  반려: \`!reject ${display.approvalId}\``,
  ].join("\n");
}

module.exports = {
  formatBoundApproval,
  shortSha,
};

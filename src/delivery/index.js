module.exports = {
  bootstrap: require("./deliveryBootstrapService"),
  canonicalManifest: require("./canonicalSubmissionManifest"),
  finding: require("./phaseFindingService"),
  gate: require("./phaseGateService"),
  phase: require("./phaseService"),
  submission: require("./phaseSubmissionService"),
  validation: require("./phaseValidationService"),
};


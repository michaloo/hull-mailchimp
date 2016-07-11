require("babel-register")({ presets: ["es2015", "stage-0"] });

require("./mailchimp-agent-tests");
require("./ship-update");

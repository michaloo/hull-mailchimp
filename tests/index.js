require("babel-register")({ presets: ["es2015", "stage-0"] });

require("./campaign-agent-tests");
require("./mailchimp-agent-tests");
require("./ship-update");

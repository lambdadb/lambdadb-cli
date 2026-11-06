class LambdadbCli < Formula
  desc "Project-scoped LambdaDB command-line tools"
  homepage "https://github.com/lambdadb/lambdadb-cli"
  url "https://registry.npmjs.org/@functional-systems/lambdadb-cli/-/lambdadb-cli-0.4.1.tgz"
  sha256 "5791d33450c00440ed11931fcaf346a1b400ceb95173cf1618e50e627f3a0e4c"
  license "Apache-2.0"

  # Match the LTS major exercised by CLI CI without changing the user's Node installation.
  depends_on "node@24"

  resource "package-lock" do
    url "https://raw.githubusercontent.com/lambdadb/lambdadb-cli/7fce59880eb35e030ea9bd9dd4fef4f59aadf560/package-lock.json"
    sha256 "3850031a008c1c814e23a59f6c216aee623c7dfed8cc00a3b5ea1d5bb43cec77"
  end

  def install
    # npm omits the lockfile from published tarballs; use the matching immutable release source.
    libexec.install buildpath.children
    resource("package-lock").stage { libexec.install "package-lock.json" }
    cd libexec do
      system "npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    end
    (bin/"lambdadb").write_env_script libexec/"dist/cli.js", PATH: "#{formula_opt_bin("node@24")}:$PATH"
  end

  test do
    ENV.keys.grep(/^LAMBDADB_/).each { |key| ENV.delete(key) }
    assert_equal version.to_s, shell_output("#{bin}/lambdadb --version").strip
    config = testpath/"connection.json"
    output = shell_output("#{bin}/lambdadb configure --endpoint https://example.invalid " \
                          "--project homebrew-test --config #{config} --json")
    result = JSON.parse(output)
    assert_equal true, result.fetch("ok")
    assert_equal 1, result.fetch("schemaVersion")
    assert_equal "homebrew-test", JSON.parse(config.read).fetch("project")
    assert_equal 0600, config.stat.mode & 0777
  end
end

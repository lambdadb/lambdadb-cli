class LambdadbCli < Formula
  desc "Project-scoped LambdaDB command-line tools"
  homepage "https://github.com/lambdadb/lambdadb-cli"
  url "https://registry.npmjs.org/@functional-systems/lambdadb-cli/-/lambdadb-cli-0.2.2.tgz"
  sha256 "2858ec1abbb627308fe5dca744873282abcf502a61aa133dbff0e89139e2c7cf"
  license "Apache-2.0"

  # Match the LTS major exercised by CLI CI without changing the user's Node installation.
  depends_on "node@24"

  resource "package-lock" do
    url "https://raw.githubusercontent.com/lambdadb/lambdadb-cli/66af1e58c2dce8c538873fd4c8472a1428e26356/package-lock.json"
    sha256 "2489ac6b01033d1703bab4be5bee6824288d04267afc31ba780406f2cc313d88"
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

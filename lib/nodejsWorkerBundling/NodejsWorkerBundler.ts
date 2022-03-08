import util from 'util';
import webpack from 'webpack';
import * as realFS from 'fs';
import { bundleWorkflowCode } from '@temporalio/worker';
import { temporalWorkflowsBundlingBabelPlugin, WorkflowsTransformFunc } from './babelPlugin';
import path from 'path';

// FIXME: Evaluate the pertinance of contributing this file to @temporalio/worker once fully validated
export class NodejsWorkerBundler {
    private readonly entrypointPath: string;
    private readonly targetPath: string;
    private readonly entrypointPackageRoot: string;

    private readonly externalDepsPatterns: RegExp[] = [];
    private readonly workflowsBundles: { [workflowsBundleId: string]: { sourcePath: string; targetPath: string } } = {};
    private readonly packageJson: { dependencies: { [k: string]: string }; main?: string; private: boolean } = {
        dependencies: {},
        private: true,
    };

    private readonly optimize: boolean = true;

    constructor(opts: { entrypointPath: string; targetPath: string; externals?: (string | RegExp)[] }) {
        if (!path.isAbsolute(opts.entrypointPath)) throw new Error(`entrypointPath must be absolute`);

        this.entrypointPath = opts.entrypointPath;
        this.entrypointPackageRoot = findPackageRoot(this.entrypointPath);

        this.targetPath = opts.targetPath;

        this.packageJson.main = path.basename(this.entrypointPath);

        this.externalDepsPatterns = [
            // Externalize workflows bundles generated by this class, as they have not yet been created
            /^.[/](?:[a-z0-9-]+)[.]workflowbundle[.]js$/,

            // @temporalio/core-bridge package contains native code. proto and commons are dependencies
            // of core-bridge; there is therefore no use in inlining them in the bundle.
            /^@temporalio[/]core-bridge$/,
            /^@temporalio[/]proto$/,
            /^@temporalio[/]common$/,

            ...(opts.externals ?? []).map(toRegExp),
        ];
    }

    public async bundle(): Promise<void> {
        await this.bundleWorker(this.entrypointPath, this.targetPath);
        await this.bundleWorkflows(path.dirname(this.targetPath));
        await this.generatePackageJson(path.dirname(this.targetPath));
    }

    protected async bundleWorker(entry: string, target: string): Promise<void> {
        const workflowsTransform: WorkflowsTransformFunc = (workflowsPath, { filename }) => {
            if (!(workflowsPath.startsWith('./') || workflowsPath.startsWith('../')))
                throw new Error('workflowsPath must be relative');
            const sourcePath = path.resolve(path.dirname(filename), workflowsPath);

            const baseWorkflowsBundleId = path
                .basename(workflowsPath)
                .replace(/[^a-z0-9]+/i, '-')
                .replace(/^-/, '')
                .replace(/-$/, '');

            // Check and resolve collision with distinct workflows bundle that could happens to have the same ID
            let workflowsBundleId = baseWorkflowsBundleId;
            let suffix = 1;
            while (
                workflowsBundleId in this.workflowsBundles &&
                this.workflowsBundles[workflowsBundleId].sourcePath !== sourcePath
            ) {
                workflowsBundleId = `${baseWorkflowsBundleId}-${suffix++}`;
            }

            const targetPath = `./${workflowsBundleId}.workflowbundle.js`;
            this.workflowsBundles[workflowsBundleId] = { sourcePath, targetPath };

            return targetPath;
        };

        const extractDependencies: webpack.Configuration['externals'] = async (data, _callback): Promise<string> => {
            try {
                const resolvedPath = (await data.getResolve()(data.context, data.request, undefined)) as string;
                const packageRoot = findPackageRoot(resolvedPath);

                if (packageRoot && packageRoot !== this.entrypointPackageRoot) {
                    const { name: packageName, version: packageVersion } = require(`${packageRoot}/package.json`); // eslint-disable-line @typescript-eslint/no-var-requires

                    if (this.externalDepsPatterns.some((pattern) => pattern.test(packageName))) {
                        this.packageJson.dependencies[packageName] = `${packageVersion}`;
                        return `commonjs ${data.request}`;
                    }

                    return undefined;
                }
            } catch (_e) {
                /* Fallback to default logic below */
            }

            if (this.externalDepsPatterns.some((pattern) => pattern.test(data.request))) {
                if (!/^[.][.]?[/]/.test(data.request)) {
                    // Report a warning if the requested file is not relative
                    console.log(
                        `Warning: Failed to locate package.json for dependency ${data.request}.\n` +
                            `That dependency WILL NOT be added to the generated worker's package.json.\n` +
                            `This could possibly cause missing dependencies at runtime.`,
                    );
                }
                return `commonjs ${data.request}`;
            }

            return undefined;
        };

        const webpackConfig: webpack.Configuration = {
            resolve: {
                extensions: ['.ts', '.js'],
                alias: {
                    ...(this.optimize ? { webpack: false } : {}),
                },
            },
            target: 'node14.18',
            module: {
                rules: [
                    {
                        test: /\.js|\.ts$/,
                        exclude: /node_modules/,
                        use: [
                            {
                                loader: 'babel-loader',
                                options: {
                                    plugins: [[temporalWorkflowsBundlingBabelPlugin, { workflowsTransform }]],
                                },
                            },
                            {
                                loader: 'ts-loader',
                                options: {
                                    compilerOptions: {
                                        // Retain import statements so that they can be easily analyzed by the babel plugin
                                        module: 'es2020',
                                    },
                                },
                            },
                        ],
                    },
                ],
            },
            entry: [entry],
            mode: 'development',
            devtool: 'eval-source-map',
            output: {
                path: path.dirname(target),
                filename: path.basename(target),
            },
            externals: extractDependencies,
        };

        const compiler = webpack(webpackConfig);
        try {
            await new Promise<void>((resolve, reject) => {
                compiler.run((err, stats) => {
                    if (stats !== undefined) {
                        const hasError = stats.hasErrors();
                        const lines = stats.toString({ chunks: false, colors: true }).split('\n');
                        for (const line of lines) {
                            console[hasError ? 'error' : 'info'](line);
                        }
                        if (hasError) {
                            reject(new Error('Webpack finished with errors.'));
                        }
                    }
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        } finally {
            await util.promisify(compiler.close).bind(compiler)();
        }
    }

    protected async bundleWorkflows(targetDirectory: string): Promise<void> {
        for (const bundleDefinition of Object.values(this.workflowsBundles)) {
            console.log(``);
            console.log(`Preparing workflows bundle from directory: ${bundleDefinition.sourcePath}`);

            const { code } = await bundleWorkflowCode({
                workflowsPath: bundleDefinition.sourcePath,

                // FIXME: Capture workflowInterceptorModules on Worker.create()
                // workflowInterceptorModules: bundleDefinition.workflowInterceptorModules,
            });

            const targetFile = path.resolve(targetDirectory, bundleDefinition.targetPath);
            realFS.writeFileSync(targetFile, code, { encoding: 'utf-8' });
        }

        return;
    }

    protected async generatePackageJson(targetDirectory: string): Promise<void> {
        realFS.writeFileSync(`${targetDirectory}/package.json`, JSON.stringify(this.packageJson, null, 4), {
            encoding: 'utf-8',
        });

        return;
    }
}

function toRegExp(input: string | RegExp): RegExp {
    if (input instanceof RegExp) return input;
    if (typeof input === 'string') return new RegExp(`^${input.replace('[.?*+|\\([{^$]', '\\$&')}$`);
    throw new Error('Unsupported input type');
}

function findPackageRoot(p: string): string | null {
    if (realFS.statSync(p).isFile()) p = path.dirname(p);

    while (p !== '/') {
        if (realFS.existsSync(`${p}/package.json`)) return p;
        p = path.dirname(p);
    }

    return null;
}

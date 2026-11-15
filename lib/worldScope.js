/** 她只在她房间的工作区里才有世界工具；会话随时可能进出，所以每次执行前再查一次。 */
export class OutsideWorldError extends Error {
    constructor() { super('会话不在世界工作区内'); this.name = 'OutsideWorldError'; }
}

/** 同一个作用域检查管着执行：不在这世界就不执行。老的宿主不认注册条件，execute 里再拦一次。 */
export function registerScopedTool(agent, tool, inside, left) {
    const register = agent.ctx.tools.register.bind(agent.ctx.tools);
    const wrapped = {
        ...tool,
        execute: (args, exec) => {
            if (!inside()) {
                left?.();
                throw new OutsideWorldError();
            }
            return tool.execute(args, exec);
        },
    };
    try { return register(wrapped, { when: inside }); }
    catch { return register(wrapped); }
}

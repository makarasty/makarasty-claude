export class AppError extends Error {
    constructor(message, status, code) {
        super(message);
        this.name = this.constructor.name;
        this.status = status;
        this.code = code;
    }
}

export class ValidationError extends AppError {
    constructor(message) { super(message, 400, 'validation_error'); }
}

export class NotFoundError extends AppError {
    constructor(message) { super(message, 404, 'not_found'); }
}

export class ConflictError extends AppError {
    constructor(message) { super(message, 409, 'conflict'); }
}
